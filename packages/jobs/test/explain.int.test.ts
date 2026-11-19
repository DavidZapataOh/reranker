import { randomUUID } from "node:crypto";
import {
  expectNoSeqScanOn,
  explain,
  explainGeneric,
  type GenericPlan,
  type Queryable,
} from "@reranker/testing/db";
import { getTestDatabaseUrl } from "@reranker/testing/neon";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

// Plans are read inside a transaction that is always rolled back: the 10,000 rows per table are
// never visible to the other suites sharing the database (network.int.test owns
// ops.network_ranges and expects it empty). The owner connection can ANALYZE them, so the
// planner sees the statistics a table of that size has in production, not stale ones left by
// small test runs. Only ANALYZE's row estimate in pg_class outlives the rollback (it is written in
// place) until the next analyze, which can change the plans other suites get, never their results.
let db: pg.Client;
beforeAll(async () => {
  db = new pg.Client({ connectionString: getTestDatabaseUrl("migrations") });
  await db.connect();
});
afterAll(() => db.end());

const ROWS = 10_000;

type Table =
  | "concurrency_leases"
  | "rate_buckets"
  | "spend_counters"
  | "spend_ledger"
  | "velocity_buckets"
  | "network_ranges";

// Each seed spreads the rows the way production does (many keys, days or ranges), and the
// statements below look up the first of them.
const SEEDS: Record<Table, string> = {
  concurrency_leases: `insert into ops.concurrency_leases (key, expires_at)
    select $1 || ':' || (g % 1000), clock_timestamp() + (g % 600) * interval '1 second'
      from generate_series(0, ${ROWS - 1}) g`,
  rate_buckets: `insert into ops.rate_buckets (key, tokens, updated_at)
    select $1 || ':' || g, 10, clock_timestamp() from generate_series(0, ${ROWS - 1}) g`,
  spend_counters: `insert into ops.spend_counters
      (day, scope, cap_amount_micros, cap_currency, used_amount_micros, used_currency)
    select date '1900-01-01' + g / 10, $1 || ':' || (g % 10), 1000000, 'USD', 1000, 'USD'
      from generate_series(0, ${ROWS - 1}) g`,
  spend_ledger: `insert into ops.spend_ledger
      (day, provider, purpose, scopes, ref_type, ref_id, reserved_amount_micros,
       reserved_currency, actual_currency, status, created_at)
    select date '1900-01-01' + g / 10, 'dataforseo', 'benchmark', array['global'], 'explain',
           $1 || ':' || g, 1, 'USD', 'USD',
           case when g % 3 = 0 then 'reserved' else 'settled' end,
           clock_timestamp() - (g % 120) * interval '1 minute'
      from generate_series(0, ${ROWS - 1}) g`,
  velocity_buckets: `insert into ops.velocity_buckets
      (key, bucket_start, count, flagged, spend_amount_micros, spend_currency)
    select $1 || ':' || (g % 100),
           date_bin('1 minute', clock_timestamp(), timestamptz 'epoch') - (g / 100) * interval '1 minute',
           1, 0, 0, 'USD'
      from generate_series(0, ${ROWS - 1}) g`,
  // Class E (240.0.0.0/4) is reserved, so no real list ever holds these prefixes.
  network_ranges: `insert into ops.network_ranges (prefix, kind)
    select set_masklen('240.0.0.0'::inet + g * 16, 28)::cidr, 'hosting'
      from generate_series(0, ${ROWS - 1}) g
    on conflict do nothing`,
};

async function seed(client: Queryable, table: Table, prefix: string): Promise<void> {
  const sql = SEEDS[table];
  await client.query(sql, sql.includes("$1") ? [prefix] : []);
  await client.query(`analyze ops.${table}`);
  // ANALYZE only warns when it is not allowed, which would leave the plan to stale statistics.
  const { rows } = await client.query<{ tuples: number }>(
    "select reltuples::int as tuples from pg_class where oid = $1::regclass",
    [`ops.${table}`],
  );
  expect(rows[0]?.tuples).toBeGreaterThanOrEqual(ROWS);
}

const normalize = (text: string) => text.replace(/\s+/g, " ").trim();

/**
 * A statement exactly as the deployed function runs it: cut from its source between `start` and
 * `end`, with the PL/pgSQL variables turned into typed placeholders. Reading the live source keeps
 * this test on the function that ships, and fails it when the statement is rewritten.
 */
async function statementOf(
  client: Queryable,
  fn: string,
  start: string,
  vars: Record<string, string>,
  end = ";",
): Promise<string> {
  const { rows } = await client.query<{ src: string }>(
    "select prosrc as src from pg_proc where oid = $1::regprocedure",
    [fn],
  );
  const src = normalize(rows[0]?.src ?? "");
  const from = src.indexOf(start);
  expect(from, `${fn} has no statement starting "${start}"`).toBeGreaterThanOrEqual(0);
  expect(src.indexOf(start, from + 1), `${fn} has two statements starting "${start}"`).toBe(-1);
  const to = src.indexOf(end, from);
  expect(to).toBeGreaterThan(from);
  let statement = src
    .slice(from, to)
    // INTO is PL/pgSQL; the query that the server plans has no targets.
    .replace(/ into v_\w+(?:, v_\w+)*/g, "")
    .replace(/^perform /, "select ")
    .replace(/^return query /, "");
  Object.keys(vars).forEach((name, i) => {
    statement = statement.replace(new RegExp(`\\b${name}\\b`, "g"), `$${i + 1}::${vars[name]}`);
  });
  expect(statement, `${fn}: a variable was left unbound`).not.toMatch(/\b[pv]_\w+/);
  return statement;
}

type Case = {
  fn?: string;
  start?: string;
  end?: string;
  sql?: string;
  vars: Record<string, string>;
  values: (prefix: string, client: Queryable) => Promise<unknown[]> | unknown[];
};

// Checks both plans a PL/pgSQL statement can run with: the custom plan of its first executions
// (EXPLAIN ANALYZE with the values bound) and the generic plan it may switch to afterwards.
async function expectIndexed(client: Queryable, c: Case, table: Table, prefix: string) {
  const statement =
    c.sql ?? (await statementOf(client, c.fn as string, c.start as string, c.vars, c.end ?? ";"));
  const plans: [string, GenericPlan][] = [
    ["custom", await explain(client, statement, await c.values(prefix, client))],
    ["generic", await explainGeneric(client, statement)],
  ];
  for (const [kind, plan] of plans) {
    try {
      expectNoSeqScanOn(plan, `ops.${table}`);
    } catch (error) {
      throw new Error(`${kind} plan of ${statement}\n${(error as Error).message}`);
    }
  }
}

const ACQUIRE = "ops.acquire_slot(text,int,int,text[],float8[],float8[],float8[])";
const ACQUIRE_MANY = "ops.acquire_slots(text,int,int,int,uuid[],text[],float8[],float8[],float8[])";
const TAKE = "ops.take_tokens(text[],float8[],float8[],float8[])";
const RESERVE = "ops.reserve_spend(date,text[],bigint[],text,bigint,bigint,jsonb)";
const SETTLE = "ops.settle_spend(uuid,bigint)";
const RELEASE = "ops.release_spend(uuid)";
const STALE = "ops.release_stale_reservations(date,interval)";
const VELOCITY = "ops.record_velocity(text,boolean,bigint)";

const DAY = "1900-01-01";
const scopes = (prefix: string) => [`${prefix}:0`, `${prefix}:1`, `${prefix}:2`];
const ledgerId = async (prefix: string, client: Queryable) => {
  const { rows } = await client.query<{ id: string }>(
    "select id from ops.spend_ledger where ref_type = 'explain' and ref_id = $1",
    [`${prefix}:0`],
  );
  return rows[0]?.id;
};

const CASES: [string, Table, Case][] = [
  [
    "acquire_slot: expired leases",
    "concurrency_leases",
    {
      fn: ACQUIRE,
      start: "delete from ops.concurrency_leases l",
      vars: { p_key: "text", v_now: "timestamptz" },
      values: (p) => [`${p}:0`, new Date()],
    },
  ],
  [
    "acquire_slot: live leases",
    "concurrency_leases",
    {
      fn: ACQUIRE,
      start: "select count(*), min(l.expires_at)",
      vars: { p_key: "text" },
      values: (p) => [`${p}:0`],
    },
  ],
  [
    "acquire_slots: released leases",
    "concurrency_leases",
    {
      fn: ACQUIRE_MANY,
      start: "delete from ops.concurrency_leases l where l.lease_id",
      vars: { p_released: "uuid[]", p_key: "text" },
      values: (p) => [[randomUUID(), randomUUID()], `${p}:0`],
    },
  ],
  [
    "acquire_slots: expired leases",
    "concurrency_leases",
    {
      fn: ACQUIRE_MANY,
      start: "delete from ops.concurrency_leases l where l.key",
      vars: { p_key: "text", v_now: "timestamptz" },
      values: (p) => [`${p}:0`, new Date()],
    },
  ],
  [
    "acquire_slots: live leases",
    "concurrency_leases",
    {
      fn: ACQUIRE_MANY,
      start: "select count(*), min(l.expires_at)",
      vars: { p_key: "text" },
      values: (p) => [`${p}:0`],
    },
  ],
  [
    "acquireProviderSlot: release",
    "concurrency_leases",
    {
      sql: "delete from ops.concurrency_leases where lease_id = $1::uuid",
      vars: {},
      values: () => [randomUUID()],
    },
  ],
  [
    "providerCapacity: in flight",
    "concurrency_leases",
    {
      sql: "select count(*)::int as in_flight from ops.concurrency_leases where key = $1::text and expires_at > clock_timestamp()",
      vars: {},
      values: (p) => [`${p}:0`],
    },
  ],
  [
    "take_tokens: lock",
    "rate_buckets",
    {
      fn: TAKE,
      start: "perform 1 from ops.rate_buckets r",
      vars: { p_keys: "text[]" },
      values: (p) => [[`${p}:1`, `${p}:2`]],
    },
  ],
  [
    "take_tokens: levels",
    "rate_buckets",
    {
      fn: TAKE,
      start: "select bool_and(",
      vars: {
        p_keys: "text[]",
        p_caps: "float8[]",
        p_refills: "float8[]",
        p_costs: "float8[]",
        v_now: "timestamptz",
      },
      values: (p) => [[`${p}:1`, `${p}:2`], [10, 10], [1, 1], [1, 1], new Date()],
    },
  ],
  [
    "take_tokens: take",
    "rate_buckets",
    {
      fn: TAKE,
      start: "update ops.rate_buckets r",
      vars: { p_keys: "text[]", v_levels: "float8[]", p_costs: "float8[]", v_now: "timestamptz" },
      values: (p) => [[`${p}:1`, `${p}:2`], [10, 10], [1, 1], new Date()],
    },
  ],
  [
    "reserve_spend: currency check",
    "spend_counters",
    {
      fn: RESERVE,
      start: "select from ops.spend_counters c",
      end: ") then",
      vars: {
        p_day: "date",
        p_scopes: "text[]",
        p_fallback_scope: "text",
        v_currency: "app.currency_code",
      },
      values: (p) => [DAY, scopes(p), null, "USD"],
    },
  ],
  [
    "reserve_spend: denied scopes",
    "spend_counters",
    {
      fn: RESERVE,
      start: "select array_agg(c.scope",
      vars: { v_scopes: "text[]", p_day: "date", p_amount: "bigint" },
      values: (p) => [scopes(p), DAY, 1],
    },
  ],
  [
    "reserve_spend: charge",
    "spend_counters",
    {
      fn: RESERVE,
      start: "update ops.spend_counters c",
      vars: { p_amount: "bigint", p_day: "date", v_scopes: "text[]" },
      values: (p) => [1, DAY, scopes(p)],
    },
  ],
  [
    "reserve_spend: result",
    "spend_counters",
    {
      fn: RESERVE,
      start: "return query select v_id",
      vars: { v_id: "uuid", v_denied: "text[]", v_scopes: "text[]", p_day: "date" },
      values: (p) => [null, null, scopes(p), DAY],
    },
  ],
  [
    "release_stale_reservations: stale",
    "spend_ledger",
    {
      fn: STALE,
      start: "with released as (",
      vars: { p_day: "date", p_older_than: "interval" },
      values: () => [DAY, "15 minutes"],
    },
  ],
  [
    "release_stale_reservations: counters",
    "spend_counters",
    {
      fn: STALE,
      start: "update ops.spend_counters c",
      vars: { p_day: "date", v_scopes: "text[]", v_amounts: "bigint[]" },
      values: (p) => [DAY, scopes(p), [1, 1, 1]],
    },
  ],
  [
    "settle_spend: ledger",
    "spend_ledger",
    {
      fn: SETTLE,
      start: "update ops.spend_ledger l",
      vars: { p_actual: "bigint", p_ledger_id: "uuid" },
      values: async (p, client) => [0, await ledgerId(p, client)],
    },
  ],
  [
    "settle_spend: counters",
    "spend_counters",
    {
      fn: SETTLE,
      start: "update ops.spend_counters c",
      vars: { v_reserved: "bigint", p_actual: "bigint", v_day: "date", v_scopes: "text[]" },
      values: (p) => [1, 0, DAY, scopes(p)],
    },
  ],
  [
    "release_spend: ledger",
    "spend_ledger",
    {
      fn: RELEASE,
      start: "update ops.spend_ledger l",
      vars: { p_ledger_id: "uuid" },
      values: async (p, client) => [await ledgerId(p, client)],
    },
  ],
  [
    "spendStatus",
    "spend_counters",
    {
      sql: "select scope, used_amount_micros as used from ops.spend_counters where day = $1::date and scope = any ($2::text[])",
      vars: {},
      values: (p) => [DAY, scopes(p)],
    },
  ],
  [
    "costOf",
    "spend_ledger",
    {
      sql: "select coalesce(sum(actual_amount_micros), 0)::bigint as total from ops.spend_ledger where ref_type = $1::text and ref_id = $2::text and status = 'settled'",
      vars: {},
      values: (p) => ["explain", `${p}:1`],
    },
  ],
  [
    "record_velocity: windows",
    "velocity_buckets",
    {
      fn: VELOCITY,
      start: "return query select coalesce(",
      vars: { v_bucket: "timestamptz", p_key: "text" },
      values: (p) => [new Date(), `${p}:0`],
    },
  ],
  [
    "classifyNetwork",
    "network_ranges",
    {
      sql: "select kind from ops.network_ranges where prefix >>= $1::inet order by masklen(prefix) desc limit 1",
      vars: {},
      values: () => ["240.0.1.1"],
    },
  ],
];

describe(`with ${ROWS.toLocaleString("en")} rows per table`, () => {
  test.each(CASES)("%s reads %s through an index", async (_, table, c) => {
    const prefix = `explain:${randomUUID()}`;
    await db.query("begin");
    try {
      await seed(db, table, prefix);
      await expectIndexed(db, c, table, prefix);
    } finally {
      await db.query("rollback");
    }
  });
});
