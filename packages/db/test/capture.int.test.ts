import { createHash, randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { EngineId } from "@reranker/schema";
import { expectNoSeqScanOn, explain } from "@reranker/testing/db";
import { getTestDatabaseUrl } from "@reranker/testing/neon";
import pg from "pg";
import { afterAll, beforeAll, expect, test } from "vitest";
import { runMigrations } from "../scripts/migrate";
import { createScratchDatabase, type ScratchDatabase } from "./helpers";
import { onDatabase } from "./probe/database";

let scratch: ScratchDatabase;
let owner: pg.Client;
let system: pg.Client;
let app: pg.Client;
let measurementId: string;

const sha = (seed: string) => createHash("sha256").update(seed).digest();
const other32 = sha("other");

async function connect(url: string): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  return client;
}

beforeAll(async () => {
  scratch = await createScratchDatabase("capture");
  await runMigrations({
    url: scratch.url,
    migrationsFolder: fileURLToPath(new URL("../migrations", import.meta.url)),
    concurrentFolder: fileURLToPath(new URL("../migrations/concurrent", import.meta.url)),
  });
  owner = await connect(scratch.url);
  system = await connect(onDatabase(getTestDatabaseUrl("system"), scratch.name));
  app = await connect(onDatabase(getTestDatabaseUrl("app"), scratch.name));
  measurementId = await insertPlan(9);
}, 180_000);

afterAll(async () => {
  await Promise.allSettled([owner?.end(), system?.end(), app?.end()]);
  await scratch?.drop();
});

const sys = (sql: string, values?: unknown[]) => system.query(sql, values);

async function insertPlan(slotCount: number, db: pg.Client = system): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `insert into public_panel.measurement_plans (purpose, ref_type, ref_id, digest, slot_count)
     values ('free-report', 'report', $1, $2, $3) returning id`,
    [randomUUID(), sha(randomUUID()), slotCount],
  );
  return rows[0]?.id as string;
}

type CaptureInput = {
  slotIndex: number;
  status?: "succeeded" | "provider_error" | "timeout";
  envelope?: Buffer | null;
  plan?: string;
  integrated?: boolean;
};

const CAPTURE_COLUMNS = `measurement_id, slot_index, attempt, intent_set_id, intent_id, engine,
  channel, provider, mode, status, provider_status_code, http_status, model_reported,
  response_bytes, parser_version, latency_ms, cost_amount_micros, cost_currency,
  envelope_sha256, normalized_sha256, log_index`;

let logIndex = 0;

async function insertCapture(input: CaptureInput): Promise<string> {
  // Same length as cap_ + ULID, so row sizes match production.
  const id = `cap_${randomBytes(13).toString("hex").toUpperCase()}`;
  const integrated = input.integrated ?? false;
  await sys(
    `insert into public_panel.captures (id, ${CAPTURE_COLUMNS})
     values ($1, $2, $3, 1, 'is_0123456789abcdef', 'odontologia.blanqueamiento-dental', 'gemini',
       'ui-vendor', 'dataforseo', 'live', $4, 20000, 200, 'gemini-3-flash', 48213, 1, 11834,
       4000, 'USD', $5, $6, $7)`,
    [
      id,
      input.plan ?? measurementId,
      input.slotIndex,
      input.status ?? "succeeded",
      input.envelope === undefined ? sha(id) : input.envelope,
      sha(`normalized:${id}`),
      integrated ? ++logIndex : null,
    ],
  );
  return id;
}

test("one succeeded capture per slot, failures may repeat", async () => {
  await insertCapture({ slotIndex: 1, status: "provider_error" });
  await insertCapture({ slotIndex: 1, status: "provider_error" });
  await insertCapture({ slotIndex: 1, status: "succeeded" });
  await expect(insertCapture({ slotIndex: 1, status: "succeeded" })).rejects.toMatchObject({
    code: "23505",
  });
});

test.each(["measurement_plans", "captures"])(
  "app role reads %s and cannot write it",
  async (table) => {
    await expect(app.query(`select * from public_panel.${table} limit 1`)).resolves.toBeDefined();
    const writes = [
      table === "measurement_plans"
        ? `insert into public_panel.measurement_plans (purpose, ref_type, ref_id, digest, slot_count)
         values ('benchmark', 'probe', 'x', '\\x00', 1)`
        : `insert into public_panel.captures (id) values ('cap_x')`,
      `update public_panel.${table} set id = id`,
      `delete from public_panel.${table}`,
    ];
    for (const sql of writes) {
      await expect(app.query(sql)).rejects.toMatchObject({ code: "42501" });
    }
  },
);

test("a plan's purpose is one of the spend purposes", async () => {
  await expect(
    sys(
      `insert into public_panel.measurement_plans (purpose, ref_type, ref_id, digest, slot_count)
       values ('marketing', 'report', 'x', $1, 1)`,
      [sha("x")],
    ),
  ).rejects.toMatchObject({ code: "23514" });
});

// Sizes as Postgres stores them: each heap row plus its line pointer, and one entry per row in
// every index (8-byte tuple header and key, aligned to 8, plus its line pointer).
async function bytesOf(
  plan: string,
): Promise<{ total: number; evidence: number; parts: Record<string, number> }> {
  const scopes: Record<string, string> = {
    "public_panel.captures": "measurement_id = $1",
    "public_panel.measurement_plans": "id = $1",
  };
  const parts: Record<string, number> = {};
  for (const [table, scope] of Object.entries(scopes)) {
    const { rows } = await owner.query<{ b: number }>(
      `select coalesce(sum(pg_column_size(t.*) + 4), 0)::int as b from ${table} t where ${scope}`,
      [plan],
    );
    parts[table] = rows[0]?.b ?? 0;
  }
  const { rows: indexes } = await owner.query<{
    name: string;
    table: string;
    columns: string[];
    pred: string;
  }>(
    `select i.indexrelid::regclass::text as name, i.indrelid::regclass::text as table,
       array(select a.attname::text from unnest(i.indkey) k
             join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k) as columns,
       coalesce(pg_get_expr(i.indpred, i.indrelid), 'true') as pred
     from pg_index i where i.indrelid = any($1::regclass[])`,
    [Object.keys(scopes)],
  );
  expect(indexes.length).toBeGreaterThanOrEqual(8);
  for (const index of indexes) {
    const key = index.columns.map((column) => `pg_column_size(${column})`).join(" + ");
    const { rows } = await owner.query<{ b: number }>(
      `select coalesce(sum(4 + ((8 + ${key} + 7) / 8) * 8), 0)::int as b
       from ${index.table} where ${scopes[index.table]} and (${index.pred})`,
      [plan],
    );
    parts[index.name] = rows[0]?.b ?? 0;
  }
  const total = Object.values(parts).reduce((sum, bytes) => sum + bytes, 0);
  const { rows } = await owner.query<{ b: number }>(
    `select sum(pg_column_size(envelope_sha256) + pg_column_size(normalized_sha256)
              + pg_column_size(log_index) + 4 + ((8 + pg_column_size(log_index) + 7) / 8) * 8)::int as b
     from public_panel.captures where measurement_id = $1`,
    [plan],
  );
  return { total, evidence: rows[0]?.b ?? 0, parts };
}

test("a 200-observation plan stays within 52 KB of rows and index entries, evidence columns included", async () => {
  const plan = await insertPlan(200);
  for (let slot = 0; slot < 200; slot++) {
    await insertCapture({ slotIndex: slot, plan, integrated: true });
  }
  const b = await bytesOf(plan);
  console.info(`captures+plans bytes per report: ${b.total} (evidence share ${b.evidence})`);
  console.info(JSON.stringify(b.parts));
  expect(b.evidence).toBeGreaterThan(0);
  expect(b.total).toBeLessThanOrEqual(52 * 1024);
});

test("evidence columns: envelope and normalized never change, log_index only once, no delete", async () => {
  const id = await insertCapture({ slotIndex: 2, status: "succeeded" });
  await expect(
    sys("update public_panel.captures set envelope_sha256 = $1 where id = $2", [other32, id]),
  ).rejects.toThrow(/immutable/);
  await expect(
    sys("update public_panel.captures set normalized_sha256 = $1 where id = $2", [other32, id]),
  ).rejects.toThrow(/immutable/);
  await sys("update public_panel.captures set log_index = 1000007 where id = $1", [id]);
  await expect(
    sys("update public_panel.captures set log_index = 1000008 where id = $1", [id]),
  ).rejects.toThrow(/immutable/);
  await expect(
    sys("update public_panel.captures set log_index = null where id = $1", [id]),
  ).rejects.toThrow(/immutable/);
  await sys("update public_panel.captures set late = true where id = $1", [id]);
  await expect(sys("delete from public_panel.captures where id = $1", [id])).rejects.toThrow(
    /immutable/,
  );
});

test("a capture without envelope is rejected", async () => {
  await expect(insertCapture({ slotIndex: 3, envelope: null })).rejects.toMatchObject({
    code: "23502",
  });
});

test("digests are exactly 32 bytes", async () => {
  await expect(insertCapture({ slotIndex: 4, envelope: Buffer.alloc(33) })).rejects.toMatchObject({
    code: "23514",
  });
});

test("the pending log queue uses its partial index with 10,000 rows", async () => {
  // Rolled back so the rows never count toward the other tests; the owner can ANALYZE them.
  await owner.query("begin");
  try {
    const plan = await insertPlan(10_000, owner);
    await owner.query(
      `insert into public_panel.captures (id, ${CAPTURE_COLUMNS})
       select 'cap_' || lpad(g::text, 26, '0'), $1, g % 30000, 1, 'is_0123456789abcdef',
         'odontologia.blanqueamiento-dental', 'gemini', 'ui-vendor', 'dataforseo', 'live',
         case when g % 3 = 0 then 'provider_error' else 'succeeded' end::public_panel.capture_status,
         20000, 200, null, 48213, 1, 11834, 4000, 'USD',
         sha256(g::text::bytea), null, case when g % 10 = 0 then null else 1000000000 + g end
       from generate_series(1, 10000) g`,
      [plan],
    );
    await owner.query("analyze public_panel.captures");
    const queryPlan = await explain(
      owner,
      "select envelope_sha256 from public_panel.captures where log_index is null order by envelope_sha256 limit 5000",
    );
    expectNoSeqScanOn(queryPlan, "public_panel.captures");
  } finally {
    await owner.query("rollback");
  }
});

test("no column stores raw bytes", async () => {
  const { rows } = await owner.query<{ column_name: string }>(
    `select column_name from information_schema.columns
     where table_schema = 'public_panel' and table_name = 'captures' and data_type = 'bytea'`,
  );
  expect(rows.map((row) => row.column_name).sort()).toEqual([
    "envelope_sha256",
    "normalized_sha256",
  ]);
  const { rows: checks } = await owner.query<{ def: string }>(
    `select pg_get_constraintdef(oid) as def from pg_constraint
     where conrelid = 'public_panel.captures'::regclass and contype = 'c'`,
  );
  for (const column of ["envelope_sha256", "normalized_sha256"]) {
    expect(checks.some(({ def }) => def.includes(`octet_length(${column}) = 32`))).toBe(true);
  }
});

test("engine enum lists every engine", async () => {
  const { rows } = await owner.query<{ engines: string[] }>(
    "select enum_range(null::public_panel.capture_engine)::text[] as engines",
  );
  expect(rows[0]?.engines).toEqual([...EngineId.options]);
});
