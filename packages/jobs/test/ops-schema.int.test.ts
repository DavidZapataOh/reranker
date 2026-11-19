import { randomUUID } from "node:crypto";
import { asTenantId, endPools, withSystem, withTenant } from "@reranker/db";
import { type SQL, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

// Concurrency is real only with more connections than the default three of the system pool.
const CONNECTIONS = 20;
beforeAll(() => {
  process.env.DB_POOL_MAX = String(CONNECTIONS);
});
afterAll(() => endPools());

type Row = Record<string, unknown>;

const system = async <R extends Row>(query: SQL): Promise<R[]> =>
  (await withSystem("test.ops", (tx) => tx.execute(query))).rows as R[];

const one = async <R extends Row>(query: SQL): Promise<R> => {
  const [row] = await system<R>(query);
  if (!row) throw new Error("expected a row");
  return row;
};

const asTenant = (query: SQL) => withTenant(asTenantId(randomUUID()), (tx) => tx.execute(query));

const unique = (prefix: string) => `test:${prefix}:${randomUUID()}`;
// Every connection stays busy at once, but no call queues in pg-pool, whose 2 s checkout timeout
// would otherwise fail calls stuck behind a contended row lock on a remote database.
async function times<T>(n: number, fn: (i: number) => Promise<T>): Promise<T[]> {
  const results: T[] = new Array(n);
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < n; i = next++) results[i] = await fn(i);
  };
  await Promise.all(Array.from({ length: Math.min(n, CONNECTIONS) }, worker));
  return results;
}
// Drizzle expands a bare array into a parenthesized list; a Param binds it as one array value.
const list = (values: unknown[]) => sql.param(values);
const pgCode = (code: string) => ({ cause: expect.objectContaining({ code }) });
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
// Polls until `count` backends wait on a lock held by `pid`, so a test can order transactions.
async function waitUntilBlockedBy(pid: number, count = 1) {
  for (let attempt = 0; attempt < 400; attempt++) {
    const { blocked } = await one<{ blocked: number }>(sql`select count(*)::int as blocked
      from pg_stat_activity a where ${pid}::int = any (pg_blocking_pids(a.pid))`);
    if (blocked >= count) return;
    await delay(25);
  }
  throw new Error(`fewer than ${count} backends waited on ${pid}`);
}

const PRIMARY_KEYS: Record<string, string[]> = {
  alert_deliveries: ["kind", "bucket_hour"],
  workflow_starts: ["kind", "key"],
  lease_pools: ["key"],
  concurrency_leases: ["lease_id"],
  rate_buckets: ["key"],
  spend_counters: ["day", "scope"],
  spend_ledger: ["id"],
  breaker_windows: ["provider", "account", "bucket_start"],
  breaker_state: ["provider", "account"],
  quota_counters: ["day", "name", "priority"],
  opportunistic_runs: ["name"],
  velocity_buckets: ["key", "bucket_start"],
  velocity_baselines: ["key"],
  guard_modes: ["name"],
  network_ranges: ["prefix"],
  network_ranges_meta: ["source_commit"],
};

const FUNCTIONS = [
  "acquire_slot",
  "acquire_slots",
  "take_tokens",
  "peek_tokens",
  "refund_tokens",
  "lock_spend_day",
  "reserve_spend",
  "settle_spend",
  "release_spend",
  "release_stale_reservations",
  "breaker_check",
  "breaker_record",
  "breaker_record_transition",
  "breaker_record_outcomes",
  "record_velocity",
  "trip_guard_mode",
  "guard_mode_status",
  "consume_quota",
];

describe("catalog", () => {
  test("every ops table exists with its natural primary key and no other unique constraint", async () => {
    const rows = await system<{ table: string; columns: string[]; contype: string }>(sql`
      select c.relname as table, k.contype,
             array(select a.attname::text from unnest(k.conkey) with ordinality u(attnum, n)
                   join pg_attribute a on a.attrelid = c.oid and a.attnum = u.attnum order by u.n) as columns
        from pg_constraint k
        join pg_class c on c.oid = k.conrelid
        join pg_namespace s on s.oid = c.relnamespace
       where s.nspname = 'ops' and k.contype in ('p', 'u')`);
    const own = rows.filter((row) => row.table in PRIMARY_KEYS);
    expect(own.filter((row) => row.contype === "u")).toEqual([]);
    const keys = Object.fromEntries(own.map((row) => [row.table, row.columns]));
    expect(keys).toEqual(PRIMARY_KEYS);
  });

  test("the extra spend and breaker columns exist with their types", async () => {
    const rows = await system<{ column: string; type: string; nullable: boolean }>(sql`
      select c.relname || '.' || a.attname as column, format_type(a.atttypid, a.atttypmod) as type,
             not a.attnotnull as nullable
        from pg_attribute a join pg_class c on c.oid = a.attrelid
        join pg_namespace s on s.oid = c.relnamespace
       where s.nspname = 'ops' and (c.relname, a.attname) in
             (('spend_ledger', 'scopes'), ('spend_ledger', 'pool'), ('breaker_state', 'opened_at'),
              ('spend_ledger', 'actual_amount_micros'))
       order by 1`);
    expect(rows).toEqual([
      { column: "breaker_state.opened_at", type: "timestamp with time zone", nullable: true },
      { column: "spend_ledger.actual_amount_micros", type: "app.amount_micros", nullable: false },
      { column: "spend_ledger.pool", type: "text", nullable: true },
      { column: "spend_ledger.scopes", type: "text[]", nullable: false },
    ]);
  });

  test("the lookup indexes exist, the network one as GiST with inet_ops", async () => {
    const rows = await system<{ name: string; definition: string }>(sql`
      select c.relname as name, pg_get_indexdef(c.oid) as definition
        from pg_index i join pg_class c on c.oid = i.indexrelid
        join pg_namespace s on s.oid = c.relnamespace
       where s.nspname = 'ops' and not i.indisprimary order by 1`);
    expect(rows.map((row) => row.name)).toEqual([
      "concurrency_leases_key_expires_at_idx",
      "network_ranges_prefix_gist_idx",
      "spend_ledger_day_provider_idx",
      "spend_ledger_ref_type_ref_id_idx",
      "spend_ledger_reserved_day_created_at_idx",
    ]);
    const definition = (name: string) => rows.find((row) => row.name === name)?.definition;
    expect(definition("network_ranges_prefix_gist_idx")).toContain("USING gist (prefix inet_ops)");
    expect(definition("spend_ledger_reserved_day_created_at_idx")).toContain(
      "WHERE (status = 'reserved'::text)",
    );
  });

  test("every function is SECURITY INVOKER and executable by app_system only", async () => {
    const rows = await system<{
      name: string;
      definer: boolean;
      system: boolean;
      tenant: boolean;
      public: boolean;
    }>(sql`
      select p.proname as name, p.prosecdef as definer,
             has_function_privilege('app_system', p.oid, 'EXECUTE') as system,
             has_function_privilege('app_tenant', p.oid, 'EXECUTE') as tenant,
             exists (select from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner)))
                      where grantee = 0 and privilege_type = 'EXECUTE') as public
        from pg_proc p join pg_namespace s on s.oid = p.pronamespace
       where s.nspname = 'ops' order by 1`);
    expect(rows.map((row) => row.name)).toEqual([...FUNCTIONS].sort());
    for (const row of rows) {
      expect(row).toEqual({
        name: row.name,
        definer: false,
        system: true,
        tenant: false,
        public: false,
      });
    }
  });

  test("every function runs with a pinned search_path", async () => {
    const rows = await system<{ name: string; config: string[] | null }>(sql`
      select p.proname as name, p.proconfig as config
        from pg_proc p join pg_namespace s on s.oid = p.pronamespace
       where s.nspname = 'ops' order by 1`);
    expect(rows).toEqual(
      [...FUNCTIONS]
        .sort()
        .map((name) => ({ name, config: ["search_path=pg_catalog, ops, app, pg_temp"] })),
    );
  });

  test("functions the migration owner creates later are not executable by PUBLIC", async () => {
    const rows = await system<{ schema: string | null; grantee: string; privilege: string }>(sql`
      select n.nspname as schema, coalesce(g.rolname, 'PUBLIC') as grantee,
             a.privilege_type as privilege
        from pg_default_acl d
        left join pg_namespace n on n.oid = d.defaclnamespace
       cross join aclexplode(d.defaclacl) a
        left join pg_roles g on g.oid = a.grantee
       where d.defaclrole = 'reranker_owner'::regrole and d.defaclobjtype = 'f'
       order by 1 nulls first, 2`);
    expect(rows).toEqual([
      { schema: null, grantee: "reranker_owner", privilege: "EXECUTE" },
      { schema: "ops", grantee: "app_system", privilege: "EXECUTE" },
    ]);
  });

  test("the tenant role cannot read ops nor call its functions", async () => {
    await expect(asTenant(sql`select * from ops.spend_counters`)).rejects.toMatchObject(
      pgCode("42501"),
    );
    await expect(
      asTenant(sql`select * from ops.take_tokens(array['k'], array[1], array[1], array[1])`),
    ).rejects.toMatchObject(pgCode("42501"));
  });

  test("check constraints reject unknown kinds, statuses and priorities", async () => {
    await expect(
      system(sql`insert into ops.network_ranges (prefix, kind) values ('10.0.0.0/8', 'isp')`),
    ).rejects.toMatchObject(pgCode("23514"));
    await expect(
      system(
        sql`insert into ops.quota_counters (day, name, priority) values ('2026-01-01', 'q', 'urgent')`,
      ),
    ).rejects.toMatchObject(pgCode("23514"));
    await expect(
      system(sql`insert into ops.workflow_starts (kind, key, status) values ('k', 'k', 'done')`),
    ).rejects.toMatchObject(pgCode("23514"));
    await expect(
      system(sql`
        insert into ops.spend_ledger (day, provider, purpose, scopes, ref_type, ref_id,
          reserved_amount_micros, reserved_currency, actual_currency, status)
        values ('2026-01-01', 'openai', 'benchmark', '{global}', 't', 'r', 1, 'USD', 'USD', 'lost')`),
    ).rejects.toMatchObject(pgCode("23514"));
  });
});

type Take = { ok: boolean; remaining: number[]; retry_after_ms: number };

const take = (keys: string[], caps: number[], refills: number[], costs: number[]) =>
  one<Take>(sql`select * from ops.take_tokens(${list(keys)}::text[], ${list(caps)}::float8[],
    ${list(refills)}::float8[], ${list(costs)}::float8[])`);
const peek = (key: string, cap: number, refill: number) =>
  one<{ remaining: number; retry_after_ms: number }>(
    sql`select * from ops.peek_tokens(${key}, ${cap}, ${refill})`,
  );
const refund = (key: string, cap: number, refill: number, cost: number) =>
  system(sql`select ops.refund_tokens(${key}, ${cap}, ${refill}, ${cost})`);

describe("token buckets", () => {
  const perHour = { cap: 3, refill: 3 / 3600 };

  test("3 per hour grants 3 and denies the fourth with the exact wait", async () => {
    const key = unique("bucket");
    for (let i = 0; i < 3; i++) {
      expect((await take([key], [perHour.cap], [perHour.refill], [1])).ok).toBe(true);
    }
    const denied = await take([key], [perHour.cap], [perHour.refill], [1]);
    expect(denied.ok).toBe(false);
    expect(denied.retry_after_ms).toBeGreaterThan(1_190_000);
    expect(denied.retry_after_ms).toBeLessThanOrEqual(1_200_000);
  });

  test("50 concurrent takes on one key never over-grant", async () => {
    const key = unique("bucket");
    const results = await times(50, () => take([key], [perHour.cap], [perHour.refill], [1]));
    expect(results.filter((result) => result.ok)).toHaveLength(3);
  });

  test("tokens refill with elapsed time", async () => {
    // One token per 100 s, and the clock is moved through updated_at: the seconds that round
    // trips take add hundredths of a token, never a whole one.
    const key = unique("bucket");
    const refill = 0.01;
    expect((await take([key], [10], [refill], [10])).ok).toBe(true);
    const denied = await take([key], [10], [refill], [1]);
    expect(denied.ok).toBe(false);
    expect(denied.retry_after_ms).toBeGreaterThan(90_000);
    expect(denied.retry_after_ms).toBeLessThanOrEqual(100_000);
    await system(sql`update ops.rate_buckets set updated_at = updated_at - interval '300 seconds'
      where key = ${key}`);
    const { remaining } = await peek(key, 10, refill);
    expect(remaining).toBeGreaterThanOrEqual(3);
    expect(remaining).toBeLessThan(3.5);
    expect((await take([key], [10], [refill], [3])).ok).toBe(true);
    expect((await take([key], [10], [refill], [1])).ok).toBe(false);
  });

  test("several buckets are taken all or nothing", async () => {
    const [a, b] = [unique("bucket"), unique("bucket")];
    expect((await take([b], [1], [0.001], [1])).ok).toBe(true);
    const denied = await take([a, b], [5, 1], [0.001, 0.001], [1, 1]);
    expect(denied.ok).toBe(false);
    expect(denied.remaining[0]).toBeCloseTo(5, 3);
    expect((await peek(a, 5, 0.001)).remaining).toBeCloseTo(5, 3);
  });

  test("peek does not consume, refund gives back without exceeding capacity", async () => {
    const key = unique("bucket");
    expect((await peek(key, 3, perHour.refill)).remaining).toBe(3);
    await take([key], [3], [perHour.refill], [3]);
    const before = await peek(key, 3, perHour.refill);
    expect((await peek(key, 3, perHour.refill)).remaining).toBeCloseTo(before.remaining, 3);
    expect(before.retry_after_ms).toBeGreaterThan(1_190_000);
    await refund(key, 3, perHour.refill, 1);
    expect((await take([key], [3], [perHour.refill], [1])).ok).toBe(true);
    await refund(key, 3, perHour.refill, 10);
    expect((await peek(key, 3, perHour.refill)).remaining).toBeCloseTo(3, 6);
  });

  test("a cost above the cap is rejected, since it could never be granted", async () => {
    await expect(take([unique("bucket")], [2], [1], [3])).rejects.toMatchObject(pgCode("22023"));
  });

  test("a bucket deleted while the take waits for its lock denies instead of granting", async () => {
    const key = unique("bucket");
    expect((await take([key], [5], [0.001], [1])).ok).toBe(true);
    let pending: Promise<Take> | undefined;
    await withSystem("test.ops", async (tx) => {
      const { rows } = await tx.execute(
        sql`select pg_backend_pid() as pid from ops.rate_buckets where key = ${key} for update`,
      );
      pending = take([key], [5], [0.001], [1]);
      await waitUntilBlockedBy(Number(rows[0]?.pid));
      await tx.execute(sql`delete from ops.rate_buckets where key = ${key}`);
    });
    const denied = await pending;
    expect(denied?.ok).toBe(false);
    expect(denied?.retry_after_ms).toBeGreaterThan(0);
  });

  test("mismatched arrays and non-positive refills are rejected", async () => {
    await expect(take([unique("bucket")], [1, 2], [1], [1])).rejects.toMatchObject(pgCode("22023"));
    await expect(take([unique("bucket")], [1], [0], [1])).rejects.toMatchObject(pgCode("22023"));
  });
});

type Slot = { lease_id: string | null; retry_after_ms: number };

const acquire = (
  key: string,
  limit: number,
  ttlMs: number,
  buckets: { keys: string[]; caps: number[]; refills: number[]; costs: number[] } = {
    keys: [],
    caps: [],
    refills: [],
    costs: [],
  },
) =>
  one<Slot>(sql`select * from ops.acquire_slot(${key}, ${limit}, ${ttlMs}, ${list(buckets.keys)}::text[],
    ${list(buckets.caps)}::float8[], ${list(buckets.refills)}::float8[], ${list(buckets.costs)}::float8[])`);
const liveLeases = async (key: string) =>
  Number(
    (
      await one<{ n: string }>(
        sql`select count(*) as n from ops.concurrency_leases where key = ${key} and expires_at > clock_timestamp()`,
      )
    ).n,
  );

describe("acquire_slot", () => {
  test("40 concurrent acquisitions never exceed the limit; the rest get the earliest expiry", async () => {
    const key = unique("pool");
    const results = await times(40, () => acquire(key, 5, 60_000));
    const granted = results.filter((result) => result.lease_id !== null);
    expect(granted).toHaveLength(5);
    expect(await liveLeases(key)).toBe(5);
    for (const denied of results.filter((result) => result.lease_id === null)) {
      expect(denied.retry_after_ms).toBeGreaterThan(55_000);
      expect(denied.retry_after_ms).toBeLessThanOrEqual(60_000);
    }
  });

  test("an expired lease frees its slot and is deleted on the next acquisition", async () => {
    const key = unique("pool");
    expect((await acquire(key, 1, 1)).lease_id).not.toBeNull();
    await delay(20);
    expect((await acquire(key, 1, 60_000)).lease_id).not.toBeNull();
    const rows = await one<{ n: string }>(
      sql`select count(*) as n from ops.concurrency_leases where key = ${key}`,
    );
    expect(Number(rows.n)).toBe(1);
  });

  test("the rate bucket is taken with the lease, and a denied bucket inserts no lease", async () => {
    const key = unique("pool");
    const bucket = unique("rpm");
    const rpm = { keys: [bucket], caps: [2], refills: [2 / 60], costs: [1] };
    expect((await acquire(key, 10, 60_000, rpm)).lease_id).not.toBeNull();
    expect((await acquire(key, 10, 60_000, rpm)).lease_id).not.toBeNull();
    const denied = await acquire(key, 10, 60_000, rpm);
    expect(denied.lease_id).toBeNull();
    expect(denied.retry_after_ms).toBeGreaterThan(29_000);
    expect(denied.retry_after_ms).toBeLessThanOrEqual(30_000);
    expect(await liveLeases(key)).toBe(2);
  });

  test("the pool row records the latest limit", async () => {
    const key = unique("pool");
    await acquire(key, 3, 60_000);
    await acquire(key, 7, 60_000);
    const row = await one<{ max_in_flight: number }>(
      sql`select max_in_flight from ops.lease_pools where key = ${key}`,
    );
    expect(row.max_in_flight).toBe(7);
  });
});

const acquireMany = (
  key: string,
  limit: number,
  count: number,
  opts: {
    released?: string[];
    buckets?: { keys: string[]; caps: number[]; refills: number[] };
    prices?: number[];
  } = {},
) =>
  system<Slot>(sql`select * from ops.acquire_slots(${key}, ${limit}, 60000, ${count},
    ${list(opts.released ?? [])}::uuid[], ${list(opts.buckets?.keys ?? [])}::text[],
    ${list(opts.buckets?.caps ?? [])}::float8[], ${list(opts.buckets?.refills ?? [])}::float8[],
    ${list(opts.prices ?? [])}::float8[])`);
const leasesOf = (rows: Slot[]) => rows.flatMap((row) => (row.lease_id ? [row.lease_id] : []));

describe("acquire_slots", () => {
  test("grants requests in order up to the limit, then reports the earliest expiry once", async () => {
    const key = unique("pool");
    const rows = await acquireMany(key, 3, 5);
    expect(rows.map((row) => row.lease_id === null)).toEqual([false, false, false, true]);
    expect(rows[3]?.retry_after_ms).toBeGreaterThan(55_000);
    expect(rows[3]?.retry_after_ms).toBeLessThanOrEqual(60_000);
    expect(await liveLeases(key)).toBe(3);
  });

  test("40 concurrent batches never exceed the limit", async () => {
    const key = unique("pool");
    const batches = await times(40, () => acquireMany(key, 5, 3));
    expect(batches.flatMap(leasesOf)).toHaveLength(5);
    expect(await liveLeases(key)).toBe(5);
  });

  test("frees the leases released in the same transaction before granting", async () => {
    const key = unique("pool");
    const held = leasesOf(await acquireMany(key, 2, 2));
    const rows = await acquireMany(key, 2, 2, { released: held });
    expect(leasesOf(rows)).toHaveLength(2);
    expect(await liveLeases(key)).toBe(2);
  });

  test("a release alone frees only its own pool's leases and never waits for the pool row", async () => {
    const key = unique("pool");
    const other = unique("pool");
    const [mine] = leasesOf(await acquireMany(key, 2, 1));
    const [theirs] = leasesOf(await acquireMany(other, 2, 1));
    await withSystem("test.ops", async (tx) => {
      await tx.execute(sql`select 1 from ops.lease_pools where key = ${key} for update`);
      const released = await withSystem(
        "test.ops",
        (inner) =>
          inner.execute(sql`select * from ops.acquire_slots(${key}, 2, 60000, 0,
            ${list([mine, theirs])}::uuid[], '{}'::text[], '{}'::float8[], '{}'::float8[],
            '{}'::float8[])`),
        { lockTimeoutMs: 1 },
      );
      expect(released.rows).toEqual([]);
    });
    expect(await liveLeases(key)).toBe(0);
    expect(await liveLeases(other)).toBe(1);
  });

  test("the first request its buckets deny ends the batch without a lease", async () => {
    const key = unique("pool");
    const buckets = { keys: [unique("tpm")], caps: [100], refills: [100 / 60] };
    const rows = await acquireMany(key, 10, 3, { buckets, prices: [60, 50, 10] });
    expect(leasesOf(rows)).toHaveLength(1);
    expect(rows.at(-1)?.lease_id).toBeNull();
    expect(rows.at(-1)?.retry_after_ms).toBeGreaterThan(0);
    expect(await liveLeases(key)).toBe(1);
  });

  test("a price list that does not match the requests and buckets is rejected", async () => {
    const buckets = { keys: [unique("rpm")], caps: [5], refills: [1] };
    await expect(acquireMany(unique("pool"), 5, 2, { buckets, prices: [1] })).rejects.toMatchObject(
      pgCode("22023"),
    );
    await expect(acquireMany(unique("pool"), 5, -1)).rejects.toMatchObject(pgCode("22023"));
  });
});

type Reservation = {
  ledger_id: string | null;
  denied_scope: string | null;
  scopes: string[];
  used: string[];
  caps: string[];
};

const DAY = "2026-11-16";
// Every reservation carries the global scope; this cap keeps it out of the tests' way.
const GLOBAL_CAP = 1_000_000_000_000_000;
// A day of its own keeps a test's stale reservations and counters away from every other test.
const uniqueDay = () =>
  new Date(Date.UTC(2100 + Math.floor(Math.random() * 800), 0, 1 + Math.floor(Math.random() * 365)))
    .toISOString()
    .slice(0, 10);

const reserve = (opts: {
  scopes: string[];
  caps: number[];
  amount: number;
  pool?: string;
  fallback?: { scope: string; cap: number };
  day?: string;
  currency?: string | null;
  withoutGlobal?: boolean;
}) => {
  const scopes = opts.withoutGlobal ? opts.scopes : ["global", ...opts.scopes];
  const caps = opts.withoutGlobal ? opts.caps : [GLOBAL_CAP, ...opts.caps];
  return one<Reservation>(sql`select * from ops.reserve_spend(${opts.day ?? DAY}::date,
    ${list(scopes)}::text[], ${list(caps)}::bigint[], ${opts.fallback?.scope ?? null},
    ${opts.fallback?.cap ?? null}::bigint, ${opts.amount}::bigint,
    ${JSON.stringify({
      provider: "dataforseo",
      channel: "api",
      engine: null,
      purpose: "free-report",
      pool: opts.pool ?? null,
      ref_type: "test",
      ref_id: randomUUID(),
      currency: opts.currency === undefined ? "USD" : opts.currency,
    })}::jsonb)`);
};
const settle = async (id: string, actual: number) =>
  (await one<{ ok: boolean }>(sql`select ops.settle_spend(${id}::uuid, ${actual}::bigint) as ok`))
    .ok;
const release = async (id: string) =>
  (await one<{ ok: boolean }>(sql`select ops.release_spend(${id}::uuid) as ok`)).ok;
const used = async (scope: string, day = DAY) =>
  Number(
    (
      await one<{ used: string }>(sql`select used_amount_micros as used from ops.spend_counters
        where day = ${day}::date and scope = ${scope}`)
    ).used,
  );
const ledger = (id: string) =>
  one<{ status: string; scopes: string[]; pool: string | null; actual: string; day: string }>(
    sql`select status, scopes, pool, actual_amount_micros as actual, day::text as day
          from ops.spend_ledger where id = ${id}::uuid`,
  );

describe("spend caps", () => {
  test("US$1 cap with 100 concurrent US$0.04 reservations grants exactly 25", async () => {
    const scope = unique("global");
    const results = await times(100, () =>
      reserve({ scopes: [scope], caps: [1_000_000], amount: 40_000 }),
    );
    expect(results.filter((result) => result.ledger_id)).toHaveLength(25);
    const denied = results.filter((result) => !result.ledger_id);
    expect(denied.every((result) => result.denied_scope === scope)).toBe(true);
    expect(denied[0]).toMatchObject({
      scopes: ["global", scope],
      used: [expect.any(String), "1000000"],
      caps: [String(GLOBAL_CAP), "1000000"],
    });
    expect(await used(scope)).toBe(1_000_000);
  });

  test("pools: anonymous gets exactly 15, verified 10 more, nobody exceeds its cap", async () => {
    const [purpose, anon, verified] = [unique("purpose"), unique("pool"), unique("pool")];
    const caps = { purpose: 1_000_000, anon: 600_000, verified: 400_000 };
    const anonymous = await times(100, () =>
      reserve({ scopes: [purpose, anon], caps: [caps.purpose, caps.anon], amount: 40_000 }),
    );
    expect(anonymous.filter((result) => result.ledger_id)).toHaveLength(15);
    expect(anonymous.find((result) => !result.ledger_id)?.denied_scope).toBe(anon);
    const verifiedResults = await times(20, () =>
      reserve({
        scopes: [purpose, verified],
        caps: [caps.purpose, caps.verified],
        amount: 40_000,
      }),
    );
    expect(verifiedResults.filter((result) => result.ledger_id)).toHaveLength(10);
    expect(await used(purpose)).toBe(1_000_000);
    expect(await used(anon)).toBe(600_000);
    expect(await used(verified)).toBe(400_000);
  });

  test("the fallback pool takes over only when the pool alone is short, in one call", async () => {
    const suffix = randomUUID();
    const purpose = `purpose:test-${suffix}`;
    const anon = `pool:anon-${suffix}`;
    const verified = `pool:verified-${suffix}`;
    const results = await times(40, () =>
      reserve({
        scopes: [purpose, anon],
        caps: [1_000_000, 600_000],
        amount: 40_000,
        pool: `anon-${suffix}`,
        fallback: { scope: verified, cap: 400_000 },
      }),
    );
    const granted = results.filter((result) => result.ledger_id);
    expect(granted).toHaveLength(25);
    expect(await used(purpose)).toBe(1_000_000);
    expect(await used(anon)).toBe(600_000);
    expect(await used(verified)).toBe(400_000);
    const borrowed = granted.filter((result) => result.scopes.includes(verified));
    expect(borrowed).toHaveLength(10);
    const row = await ledger(borrowed[0]?.ledger_id as string);
    expect(row).toMatchObject({
      pool: `verified-${suffix}`,
      scopes: ["global", purpose, verified],
    });
    expect(results.find((result) => !result.ledger_id)?.denied_scope).toBe(purpose);
  });

  test("reservations waiting on a day are admitted in arrival order", async () => {
    const [scope, day] = [unique("purpose"), uniqueDay()];
    const arrivals: Promise<Reservation>[] = [];
    await withSystem("test.ops", async (tx) => {
      const { rows } = await tx.execute<{ pid: number }>(
        sql`select pg_backend_pid() as pid, ops.lock_spend_day(${day}::date)`,
      );
      for (let i = 1; i <= 6; i++) {
        arrivals.push(reserve({ scopes: [scope], caps: [3], amount: 1, day }));
        await waitUntilBlockedBy(Number(rows[0]?.pid), i);
      }
    });
    const results = await Promise.all(arrivals);
    expect(results.map((result) => result.ledger_id !== null)).toEqual([
      true,
      true,
      true,
      false,
      false,
      false,
    ]);
  });

  test.each([
    ["settle", (id: string) => settle(id, 1)],
    ["release", (id: string) => release(id)],
  ] as const)("%s queues behind the holder of its day's lock", async (_name, run) => {
    const day = uniqueDay();
    const { ledger_id } = await reserve({
      scopes: [unique("purpose")],
      caps: [10],
      amount: 1,
      day,
    });
    let pending: Promise<boolean> | undefined;
    await withSystem("test.ops", async (tx) => {
      const { rows } = await tx.execute<{ pid: number }>(
        sql`select pg_backend_pid() as pid, ops.lock_spend_day(${day}::date)`,
      );
      pending = run(ledger_id as string);
      await waitUntilBlockedBy(Number(rows[0]?.pid));
    });
    expect(await pending).toBe(true);
  });

  test("reserve then settle leaves the actual amount and the ledger settled, once", async () => {
    const scope = unique("global");
    const reservation = await reserve({ scopes: [scope], caps: [1_000_000], amount: 4000 });
    const id = reservation.ledger_id as string;
    expect(await used(scope)).toBe(4000);
    expect(await settle(id, 3100)).toBe(true);
    expect(await settle(id, 3100)).toBe(false);
    expect(await release(id)).toBe(false);
    expect(await used(scope)).toBe(3100);
    expect(await ledger(id)).toMatchObject({ status: "settled", actual: "3100" });
  });

  test("concurrent settles and releases of one reservation apply exactly one", async () => {
    const scope = unique("global");
    const id = (await reserve({ scopes: [scope], caps: [1_000_000], amount: 4000 }))
      .ledger_id as string;
    const outcomes = await times(10, (i) => (i % 2 ? release(id) : settle(id, 3100)));
    expect(outcomes.filter(Boolean)).toHaveLength(1);
    const { status } = await ledger(id);
    expect(await used(scope)).toBe(status === "settled" ? 3100 : 0);
  });

  test("release gives the reservation back", async () => {
    const scope = unique("global");
    const id = (await reserve({ scopes: [scope], caps: [100], amount: 100 })).ledger_id as string;
    expect(await release(id)).toBe(true);
    expect(await used(scope)).toBe(0);
    expect(await ledger(id)).toMatchObject({ status: "released", actual: "0" });
  });

  test("an actual above the reservation is recorded even past the cap", async () => {
    const scope = unique("global");
    const id = (await reserve({ scopes: [scope], caps: [5000], amount: 4000 })).ledger_id as string;
    await settle(id, 9000);
    expect(await used(scope)).toBe(9000);
  });

  test("settling after midnight adjusts the reservation's day", async () => {
    const scope = unique("global");
    const id = (
      await reserve({ scopes: [scope], caps: [1_000_000], amount: 4000, day: "2026-11-15" })
    ).ledger_id as string;
    await reserve({ scopes: [scope], caps: [1_000_000], amount: 0 });
    await settle(id, 1000);
    expect(await used(scope, "2026-11-15")).toBe(1000);
    expect(await used(scope)).toBe(0);
  });

  test("stale reservations are released when a cap looks exhausted", async () => {
    const scope = unique("global");
    const stale = (await reserve({ scopes: [scope], caps: [100_000], amount: 100_000 }))
      .ledger_id as string;
    await system(sql`update ops.spend_ledger set created_at = created_at - interval '16 minutes'
      where id = ${stale}::uuid`);
    const next = await reserve({ scopes: [scope], caps: [100_000], amount: 50_000 });
    expect(next.ledger_id).not.toBeNull();
    expect((await ledger(stale)).status).toBe("released");
    expect(await used(scope)).toBe(50_000);
  });

  test("release_stale_reservations leaves fresh reservations alone", async () => {
    const scope = unique("global");
    const fresh = (await reserve({ scopes: [scope], caps: [100], amount: 100, day: "2026-10-01" }))
      .ledger_id as string;
    const old = (await reserve({ scopes: [scope], caps: [200], amount: 100, day: "2026-10-01" }))
      .ledger_id as string;
    await system(sql`update ops.spend_ledger set created_at = created_at - interval '1 hour'
      where id = ${old}::uuid`);
    const released = await one<{ n: number }>(
      sql`select ops.release_stale_reservations('2026-10-01', interval '15 minutes') as n`,
    );
    expect(released.n).toBeGreaterThanOrEqual(1);
    expect((await ledger(old)).status).toBe("released");
    expect((await ledger(fresh)).status).toBe("reserved");
    expect(await used(scope, "2026-10-01")).toBe(100);
  });

  test("every scope set starts with global, the first lock of its day", async () => {
    await expect(
      reserve({ scopes: [unique("purpose")], caps: [100], amount: 1, withoutGlobal: true }),
    ).rejects.toMatchObject(pgCode("22023"));
    await expect(
      reserve({ scopes: [`channel:${randomUUID()}`], caps: [100], amount: 1 }),
    ).rejects.toMatchObject(pgCode("22023"));
  });

  test("a currency other than the counters' is rejected and charges nothing", async () => {
    const [scope, day] = [unique("purpose"), uniqueDay()];
    await reserve({ scopes: [scope], caps: [1000], amount: 10, day });
    await expect(
      reserve({ scopes: [scope], caps: [1000], amount: 10, day, currency: "EUR" }),
    ).rejects.toMatchObject(pgCode("22023"));
    await expect(
      reserve({ scopes: [unique("purpose")], caps: [1000], amount: 10, currency: null }),
    ).rejects.toMatchObject(pgCode("22023"));
    expect(await used(scope, day)).toBe(10);
  });

  test("release_stale_reservations refuses a window shorter than 15 minutes", async () => {
    for (const window of ["14 minutes 59 seconds", null]) {
      await expect(
        system(
          sql`select ops.release_stale_reservations(${uniqueDay()}::date, ${window}::interval)`,
        ),
      ).rejects.toMatchObject(pgCode("22023"));
    }
  });

  test("a settle and a stale release of one reservation count it once, never below zero", async () => {
    const [scope, day] = [unique("purpose"), uniqueDay()];
    const reserveStale = async () => {
      const id = (await reserve({ scopes: [scope], caps: [1_000_000], amount: 4000, day }))
        .ledger_id as string;
      await system(sql`update ops.spend_ledger set created_at = created_at - interval '16 minutes'
        where id = ${id}::uuid`);
      return id;
    };
    const releaseStale = async () =>
      Number(
        (
          await one<{ n: number }>(
            sql`select ops.release_stale_reservations(${day}::date, interval '15 minutes') as n`,
          )
        ).n,
      );

    // The settle holds the ledger row, so the release skips it instead of waiting.
    const settledFirst = await reserveStale();
    await withSystem("test.ops", async (tx) => {
      await tx.execute(sql`select ops.settle_spend(${settledFirst}::uuid, 3100)`);
      expect(await releaseStale()).toBe(0);
    });
    expect(await ledger(settledFirst)).toMatchObject({ status: "settled", actual: "3100" });
    expect(await used(scope, day)).toBe(3100);

    // The release holds it, so the settle waits and then finds nothing left to settle.
    const releasedFirst = await reserveStale();
    let late: Promise<boolean> | undefined;
    await withSystem("test.ops", async (tx) => {
      const { rows } = await tx.execute(sql`select pg_backend_pid() as pid,
        ops.release_stale_reservations(${day}::date, interval '15 minutes') as n`);
      expect(Number(rows[0]?.n)).toBe(1);
      late = settle(releasedFirst, 3100);
      await waitUntilBlockedBy(Number(rows[0]?.pid));
    });
    expect(await late).toBe(false);
    expect(await ledger(releasedFirst)).toMatchObject({ status: "released", actual: "0" });
    expect(await used(scope, day)).toBe(3100);

    // Unordered and many at once: every reservation ends settled or released, never both.
    const ids = await Promise.all(Array.from({ length: 10 }, reserveStale));
    const [settles] = await Promise.all([
      Promise.all(ids.map((id) => settle(id, 3100))),
      releaseStale(),
      releaseStale(),
    ]);
    const statuses = await Promise.all(ids.map(async (id) => (await ledger(id)).status));
    const settled = statuses.filter((status) => status === "settled").length;
    expect(statuses.every((status) => status === "settled" || status === "released")).toBe(true);
    expect(settles.filter(Boolean)).toHaveLength(settled);
    expect(await used(scope, day)).toBe(3100 * (1 + settled));
  });

  test("an elsewhere pool stays charged under the fallback and, exhausted, never triggers it", async () => {
    const suffix = randomUUID();
    const [purpose, anon, verified, elsewhere] = [
      `purpose:test-${suffix}`,
      `pool:anon-${suffix}`,
      `pool:verified-${suffix}`,
      `pool:elsewhere-${suffix}`,
    ];
    const day = uniqueDay();
    const attempt = (caps: { anon: number; elsewhere: number }) =>
      reserve({
        scopes: [purpose, anon, elsewhere],
        caps: [1_000_000, caps.anon, caps.elsewhere],
        amount: 40_000,
        pool: `anon-${suffix}`,
        fallback: { scope: verified, cap: 400_000 },
        day,
      });

    expect((await attempt({ anon: 40_000, elsewhere: 200_000 })).scopes).toEqual([
      "global",
      purpose,
      anon,
      elsewhere,
    ]);
    const borrowed = await attempt({ anon: 40_000, elsewhere: 200_000 });
    expect(borrowed.scopes).toEqual(["global", purpose, verified, elsewhere]);
    expect(await ledger(borrowed.ledger_id as string)).toMatchObject({
      pool: `verified-${suffix}`,
      scopes: ["global", purpose, verified, elsewhere],
    });
    expect(await used(elsewhere, day)).toBe(80_000);
    expect(await used(verified, day)).toBe(40_000);

    // Elsewhere alone is short while the pool has room: denied there, the fallback untouched.
    const elsewhereShort = await attempt({ anon: 400_000, elsewhere: 80_000 });
    expect(elsewhereShort).toMatchObject({ ledger_id: null, denied_scope: elsewhere });
    expect(elsewhereShort.scopes).toEqual(["global", purpose, anon, elsewhere]);
    // Both short: the pool is not the only one, so the fallback is not tried either.
    const bothShort = await attempt({ anon: 40_000, elsewhere: 80_000 });
    expect(bothShort).toMatchObject({ ledger_id: null, denied_scope: anon });
    expect(await used(verified, day)).toBe(40_000);
    expect(await used(elsewhere, day)).toBe(80_000);
    expect(await used(anon, day)).toBe(40_000);
  });

  test("invalid arguments are rejected", async () => {
    await expect(
      reserve({ scopes: [unique("global")], caps: [1, 2], amount: 1 }),
    ).rejects.toMatchObject(pgCode("22023"));
    await expect(
      reserve({
        scopes: [unique("global")],
        caps: [1],
        amount: 1,
        fallback: { scope: "pool:x", cap: 1 },
      }),
    ).rejects.toMatchObject(pgCode("22023"));
  });
});

const breakerRecord = async (provider: string, account: string, failure: boolean, minCalls = 20) =>
  (
    await one<{ state: string }>(
      sql`select ops.breaker_record(${provider}, ${account}, ${failure}, ${minCalls}, 0.5, 30000) as state`,
    )
  ).state;
const breakerCheck = (provider: string, account: string, probeMs = 5000) =>
  one<{ state: string; retry_after_ms: number; opened_at: string | null }>(
    sql`select * from ops.breaker_check(${provider}, ${account}, ${probeMs}::int)`,
  );
const expireOpen = (provider: string, account: string) =>
  system(sql`update ops.breaker_state set open_until = clock_timestamp() - interval '1 millisecond'
    where provider = ${provider} and account = ${account}`);

describe("breaker", () => {
  test("20 outcomes with 12 failures open it with the full open window", async () => {
    const [provider, account] = [unique("provider"), "default"];
    const outcomes = [...Array(12).fill(true), ...Array(8).fill(false)] as boolean[];
    await times(20, (i) => breakerRecord(provider, account, outcomes[i] as boolean));
    const check = await breakerCheck(provider, account);
    expect(check.state).toBe("open");
    expect(check.retry_after_ms).toBeGreaterThan(29_000);
    expect(check.retry_after_ms).toBeLessThanOrEqual(30_000);
    expect(Number.isNaN(Date.parse(check.opened_at as string))).toBe(false);
  });

  test("19 calls never open regardless of failures", async () => {
    const provider = unique("provider");
    const states = await times(19, () => breakerRecord(provider, "default", true));
    expect(new Set(states)).toEqual(new Set(["closed"]));
    expect((await breakerCheck(provider, "default")).state).toBe("closed");
  });

  test("after the open window exactly one caller gets the probe", async () => {
    const provider = unique("provider");
    await times(20, () => breakerRecord(provider, "default", true));
    await expireOpen(provider, "default");
    // The hold is far longer than any stall a loaded runner can add, so the remaining wait seen by
    // the callers that lose never depends on how fast the round trips are.
    const holdMs = 3_600_000;
    const checks = await times(10, () => breakerCheck(provider, "default", holdMs));
    expect(checks.filter((check) => check.state === "half_open")).toHaveLength(1);
    for (const check of checks.filter((c) => c.state === "open")) {
      expect(check.retry_after_ms).toBeGreaterThan(holdMs - 60_000);
      expect(check.retry_after_ms).toBeLessThanOrEqual(holdMs);
    }
  });

  test("a successful probe closes and forgets the window; a failed one reopens keeping opened_at", async () => {
    const provider = unique("provider");
    await times(20, () => breakerRecord(provider, "default", true));
    const { opened_at: openedAt } = await breakerCheck(provider, "default");
    await expireOpen(provider, "default");
    expect((await breakerCheck(provider, "default")).state).toBe("half_open");
    expect(await breakerRecord(provider, "default", true)).toBe("open");
    const reopened = await breakerCheck(provider, "default");
    expect(reopened.state).toBe("open");
    expect(reopened.retry_after_ms).toBeGreaterThan(29_000);
    expect(reopened.opened_at).toEqual(openedAt);

    await expireOpen(provider, "default");
    expect((await breakerCheck(provider, "default")).state).toBe("half_open");
    expect(await breakerRecord(provider, "default", false)).toBe("closed");
    expect(await breakerCheck(provider, "default")).toMatchObject({
      state: "closed",
      opened_at: null,
    });
    // With the old failures still counted, a single success would reopen it at minCalls 1.
    expect(await breakerRecord(provider, "default", false, 1)).toBe("closed");
  });
});

const recordOutcomes = (provider: string, successes: number, failures: number, minCalls = 20) =>
  one<{ state: string; previous: string }>(
    sql`select * from ops.breaker_record_outcomes(${provider}, 'default', ${successes}::int,
      ${failures}::int, ${minCalls}::int, 0.5, 30000)`,
  );

describe("breaker_record_outcomes", () => {
  test("one batch of 8 successes and 12 failures opens it as 20 single records would", async () => {
    const provider = unique("provider");
    expect(await recordOutcomes(provider, 8, 12)).toEqual({ state: "open", previous: "closed" });
    const check = await breakerCheck(provider, "default");
    expect(check.state).toBe("open");
    expect(check.retry_after_ms).toBeGreaterThan(29_000);
  });

  test("batches and single records add up in the same window, as a mixed fleet records them", async () => {
    const provider = unique("provider");
    await times(10, () => breakerRecord(provider, "default", true));
    expect(await recordOutcomes(provider, 9, 0)).toEqual({ state: "closed", previous: "closed" });
    expect(await recordOutcomes(provider, 0, 1)).toEqual({ state: "open", previous: "closed" });
    // Outcomes that land while it is open are not counted toward the next window.
    expect(await recordOutcomes(provider, 50, 0)).toEqual({ state: "open", previous: "open" });
  });

  test("with a probe out, any failure in the batch reopens it and none closes it", async () => {
    const provider = unique("provider");
    await recordOutcomes(provider, 0, 20);
    await expireOpen(provider, "default");
    expect((await breakerCheck(provider, "default")).state).toBe("half_open");
    expect(await recordOutcomes(provider, 3, 1)).toEqual({ state: "open", previous: "half_open" });
    await expireOpen(provider, "default");
    expect((await breakerCheck(provider, "default")).state).toBe("half_open");
    expect(await recordOutcomes(provider, 2, 0)).toEqual({
      state: "closed",
      previous: "half_open",
    });
    expect(await breakerCheck(provider, "default")).toMatchObject({
      state: "closed",
      opened_at: null,
    });
  });

  test.each([
    [0, 0],
    [-1, 2],
    [2, -1],
  ])("%i successes and %i failures are rejected", async (successes, failures) => {
    await expect(recordOutcomes(unique("provider"), successes, failures)).rejects.toMatchObject(
      pgCode("22023"),
    );
  });
});

type Velocity = { count10m: number; flagged10m: number; spend10m: string; spend60m: string };

const recordVelocity = (key: string, flagged: boolean, spend: number) =>
  one<Velocity>(sql`select * from ops.record_velocity(${key}, ${flagged}, ${spend}::bigint)`);
const seedVelocity = (key: string, minutesAgo: number, count: number, spend: number) =>
  system(sql`insert into ops.velocity_buckets (key, bucket_start, count, flagged, spend_amount_micros, spend_currency)
    values (${key}, date_bin('1 minute', clock_timestamp(), timestamptz '1970-01-01 00:00:00+00')
      - make_interval(mins => ${minutesAgo}), ${count}, 0, ${spend}, 'USD')`);

describe("velocity", () => {
  test("ten-minute and one-hour windows sum the minute buckets in the same call", async () => {
    const key = unique("velocity");
    await seedVelocity(key, 2, 4, 3_600_000);
    await seedVelocity(key, 1, 4, 0);
    await seedVelocity(key, 30, 5, 1_000_000);
    await seedVelocity(key, 58, 5, 2_000_000);
    await seedVelocity(key, 61, 100, 9_000_000);
    let last: Velocity | undefined;
    for (let i = 0; i < 4; i++) last = await recordVelocity(key, i === 0, 900_000);
    expect(last).toEqual({
      count10m: 12,
      flagged10m: 1,
      spend10m: String(3_600_000 + 4 * 900_000),
      spend60m: String(3_600_000 + 4 * 900_000 + 3_000_000),
    });
  });

  test("after 11 minutes without writes only the new one counts", async () => {
    const key = unique("velocity");
    await seedVelocity(key, 11, 12, 0);
    expect((await recordVelocity(key, false, 0)).count10m).toBe(1);
  });

  test("a null or negative spend is rejected", async () => {
    await expect(
      system(sql`select * from ops.record_velocity(${unique("velocity")}, false, null::bigint)`),
    ).rejects.toMatchObject(pgCode("22023"));
    await expect(recordVelocity(unique("velocity"), false, -1)).rejects.toMatchObject(
      pgCode("22023"),
    );
  });

  test("concurrent records are all counted", async () => {
    const key = unique("velocity");
    await times(30, () => recordVelocity(key, false, 1));
    expect(await recordVelocity(key, true, 1)).toMatchObject({ count10m: 31, flagged10m: 1 });
  });
});

// Drizzle's node-postgres driver returns timestamptz as text.
type Trip = { active_until: string; newly_tripped: boolean };
type Status = {
  active: boolean;
  active_until: string | null;
  reason: string | null;
  released_now: boolean;
};

const trip = (name: string, holdMs: number) =>
  one<Trip>(sql`select * from ops.trip_guard_mode(${name}, 'spike', ${holdMs})`);
const status = (name: string) => one<Status>(sql`select * from ops.guard_mode_status(${name})`);
const expireGuard = (name: string) =>
  system(sql`update ops.guard_modes set active_until = clock_timestamp() - interval '1 minute'
    where name = ${name}`);

describe("guard modes", () => {
  test("trip twice extends and only the first is newly tripped", async () => {
    const name = unique("guard");
    const first = await trip(name, 30 * 60_000);
    const second = await trip(name, 30 * 60_000);
    expect([first.newly_tripped, second.newly_tripped]).toEqual([true, false]);
    expect(Date.parse(second.active_until)).toBeGreaterThanOrEqual(Date.parse(first.active_until));
    expect(await status(name)).toMatchObject({
      active: true,
      reason: "spike",
      released_now: false,
    });
    const shorter = await trip(name, 1000);
    expect(shorter.active_until).toEqual(second.active_until);
  });

  test("concurrent trips report exactly one newly tripped", async () => {
    const name = unique("guard");
    const trips = await times(10, () => trip(name, 60_000));
    expect(trips.filter((result) => result.newly_tripped)).toHaveLength(1);
  });

  test("an expired mode is released exactly once, then trips anew", async () => {
    const name = unique("guard");
    await trip(name, 60_000);
    await expireGuard(name);
    const statuses = await times(10, () => status(name));
    expect(statuses.filter((result) => result.released_now)).toHaveLength(1);
    expect(statuses.every((result) => !result.active)).toBe(true);
    expect((await status(name)).released_now).toBe(false);
    expect((await trip(name, 60_000)).newly_tripped).toBe(true);
    expect(await status(name)).toMatchObject({ active: true, released_now: false });
  });

  test("an unknown mode is inactive", async () => {
    expect(await status(unique("guard"))).toEqual({
      active: false,
      active_until: null,
      reason: null,
      released_now: false,
    });
  });
});

const consume = async (name: string, priority: string, limit: number, amount = 1) =>
  (
    await one<{ ok: boolean }>(
      sql`select ops.consume_quota(${DAY}::date, ${name}, ${priority}, ${amount}, ${limit}) as ok`,
    )
  ).ok;

describe("quotas", () => {
  test("fixed classes: 40 concurrent critical grant 30, normal and high keep theirs", async () => {
    const name = unique("quota");
    const critical = await times(40, () => consume(name, "critical", 30));
    expect(critical.filter(Boolean)).toHaveLength(30);
    const normal = await times(55, () => consume(name, "normal", 50));
    expect(normal.filter(Boolean)).toHaveLength(50);
    const high = await times(16, () => consume(name, "high", 16));
    expect(high.every(Boolean)).toBe(true);
    expect(await consume(name, "high", 16)).toBe(false);
  });

  test("an amount above the limit never inserts a counter", async () => {
    const name = unique("quota");
    expect(await consume(name, "low", 4, 5)).toBe(false);
    expect(await consume(name, "low", 4, 4)).toBe(true);
    expect(await consume(name, "low", 4)).toBe(false);
  });
});
