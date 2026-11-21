import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { getTestDatabaseUrl } from "@reranker/testing/neon";
import pg from "pg";
import { afterAll, beforeAll, expect, test } from "vitest";
import { runMigrations } from "../scripts/migrate";
import { runCatalogGate } from "./catalog-gate";
import { createScratchDatabase, type ScratchDatabase } from "./helpers";
import { onDatabase } from "./probe/database";

// Each table with a column a no-op update can name.
const NOOP_COLUMN: Record<string, string> = {
  model_regimes: "capture_count",
  control_daily: "value",
  canary_cusum: "alarm",
  canary_bocpd: "day",
  canary_baselines: "p0",
};
const TABLES = Object.keys(NOOP_COLUMN);

// Row, line pointer and index entries of one control_daily row; a canary day writes at most
// about a thousand of them.
const CONTROL_DAILY_ROW_BUDGET = 240;

let scratch: ScratchDatabase;
let owner: pg.Client;
let system: pg.Client;
let app: pg.Client;

const sha = (seed: string) => createHash("sha256").update(seed).digest();
// A variant id, as the canary names its prompts.
const prompt = () => `pv_${sha(randomUUID()).toString("hex").slice(0, 16)}`;

async function connect(url: string): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  return client;
}

beforeAll(async () => {
  scratch = await createScratchDatabase("control");
  await runMigrations({
    url: scratch.url,
    migrationsFolder: fileURLToPath(new URL("../migrations", import.meta.url)),
    concurrentFolder: fileURLToPath(new URL("../migrations/concurrent", import.meta.url)),
  });
  owner = await connect(scratch.url);
  system = await connect(onDatabase(getTestDatabaseUrl("system"), scratch.name));
  app = await connect(onDatabase(getTestDatabaseUrl("app"), scratch.name));
}, 180_000);

afterAll(async () => {
  await Promise.allSettled([owner?.end(), system?.end(), app?.end()]);
  await scratch?.drop();
});

const sys = (sql: string, values?: unknown[]) => system.query(sql, values);

test("the five tables pass the isolation catalog gate", async () => {
  const violations = await runCatalogGate(owner, new Set());
  expect(violations.filter((v) => TABLES.includes(v.table))).toEqual([]);
});

test.each(TABLES)("app_tenant reads %s and cannot write it", async (table) => {
  await expect(app.query(`select 1 from public_panel.${table} limit 1`)).resolves.toBeDefined();
  for (const sql of [
    `insert into public_panel.${table} default values`,
    `update public_panel.${table} set ${NOOP_COLUMN[table]} = ${NOOP_COLUMN[table]}`,
    `delete from public_panel.${table}`,
  ]) {
    await expect(app.query(sql)).rejects.toMatchObject({ code: "42501" });
  }
});

test("one regime per engine, channel, provider and opening; its envelope is a SHA-256", async () => {
  const opened = new Date("2026-11-20T10:05:00Z");
  const insert = (provider: string, envelope: Buffer | null = null) =>
    sys(
      `insert into public_panel.model_regimes (opened_at, first_seen_at, last_seen_at,
         capture_count, engine, channel, provider, cause, model_reported, envelope_sha256)
       values ($1, $1, $1, 1, 'chatgpt', 'api', $2, 'model', 'gpt-6.1-terra', $3)`,
      [opened, provider, envelope],
    );
  await insert("openai", sha("envelope"));
  await expect(insert("openai")).rejects.toMatchObject({ code: "23505" });
  await expect(insert("dataforseo", Buffer.alloc(31))).rejects.toMatchObject({ code: "23514" });
  await insert("dataforseo");
});

test("a regime is last seen no earlier than first seen", async () =>
  expect(
    sys(
      `insert into public_panel.model_regimes (opened_at, first_seen_at, last_seen_at, engine,
         channel, provider, cause)
       values (now(), now(), now() - interval '1 second', 'gemini', 'ui-vendor', 'dataforseo',
         'initial')`,
    ),
  ).rejects.toMatchObject({ code: "23514" }));

test("an engine-level daily metric is unique even without a prompt", async () => {
  const insert = (promptId: string | null) =>
    sys(
      `insert into public_panel.control_daily (day, engine, channel, value, n, geo_key,
         prompt_id, metric)
       values ('2026-11-20', 'google-ai-mode', 'ui-vendor', 0.98, 500, 'co-c1003654', $1,
         'completeness')`,
      [promptId],
    );
  await insert(null);
  await expect(insert(null)).rejects.toMatchObject({ code: "23505" });
  const id = prompt();
  await insert(id);
  await expect(insert(id)).rejects.toMatchObject({ code: "23505" });
});

test("a CUSUM day counts at most n runs, one row per cell and day", async () => {
  const insert = (y: number, n: number, promptId: string) =>
    sys(
      `insert into public_panel.canary_cusum (day, engine, channel, x, s_up, s_down, y, n,
         map_run_length, alarm, prompt_id)
       values ('2026-11-20', 'gemini', 'ui-vendor', -1.2, 0.4, 0, $1, $2, 17, false, $3)`,
      [y, n, promptId],
    );
  const id = prompt();
  await expect(insert(11, 10, id)).rejects.toMatchObject({ code: "23514" });
  await expect(insert(0, 0, id)).rejects.toMatchObject({ code: "23514" });
  await insert(3, 7, id);
  await expect(insert(4, 10, id)).rejects.toMatchObject({ code: "23505" });
});

test("each BOCPD cell keeps one current state", async () => {
  const cell = `${prompt()}:gemini:ui-vendor`;
  const insert = () =>
    sys(`insert into public_panel.canary_bocpd (day, cell, state) values ('2026-11-20', $1, $2)`, [
      cell,
      { logR: [0], a: [1], b: [1] },
    ]);
  await insert();
  await expect(insert()).rejects.toMatchObject({ code: "23505" });
});

test("a baseline fits mu0, sigma and h together, with sigma above zero, once per config", async () => {
  const id = prompt();
  const insert = (fit: [number | null, number | null, number | null], p0 = 0.2) =>
    sys(
      `insert into public_panel.canary_baselines (from_day, to_day, engine, channel, p0, mu0,
         sigma, h, prompt_id, reference_entities, extractor_config_hash)
       values ('2026-10-09', '2026-11-19', 'chatgpt', 'api', $1, $2, $3, $4, $5, $6, $7)`,
      [p0, ...fit, id, ["place:ChIJa", "place:ChIJb", "place:ChIJc"], sha("config")],
    );
  await expect(insert([-1.3, null, 2.84])).rejects.toMatchObject({ code: "23514" });
  await expect(insert([-1.3, 0, 2.84])).rejects.toMatchObject({ code: "23514" });
  await expect(insert([-1.3, 0.6, 2.84], 1.5)).rejects.toMatchObject({ code: "23514" });
  await insert([null, null, null], 0);
  await expect(insert([-1.3, 0.6, 2.84])).rejects.toMatchObject({ code: "23505" });
});

// Sizes as Postgres stores them: each heap row plus its line pointer, and one entry per row in
// every index (8-byte tuple header and key, aligned to 8, plus its line pointer).
async function bytesPerRow(table: string, scope: string, values: unknown[]): Promise<number> {
  const { rows: indexes } = await owner.query<{ columns: string[] }>(
    `select array(select a.attname::text from unnest(i.indkey) k
             join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k) as columns
     from pg_index i where i.indrelid = $1::regclass`,
    [`public_panel.${table}`],
  );
  const entries = indexes.map((index) => {
    const key = index.columns.map((column) => `coalesce(pg_column_size(${column}), 0)`);
    return ` + 4 + ((8 + ${key.join(" + ")} + 7) / 8) * 8`;
  });
  const { rows } = await owner.query<{ n: number; b: number }>(
    `select count(*)::int as n, coalesce(sum(pg_column_size(t.*) + 4${entries.join("")}), 0)::int as b
     from public_panel.${table} t where ${scope}`,
    values,
  );
  return (rows[0]?.b ?? 0) / (rows[0]?.n || 1);
}

test("a canary day of control_daily rows stays within its row budget", async () => {
  // Every engine metric per engine, channel and geo, then per-prompt metrics: about a thousand.
  const day = "2026-11-21";
  await sys(
    `insert into public_panel.control_daily (day, engine, channel, value, n, geo_key, prompt_id,
       metric, extractor_config_hash)
     select $1, e.engine::public_panel.capture_engine, e.channel::public_panel.capture_channel,
       random(), 10, g.geo, case when p.i = 0 then null else 'pv_' || substr(md5(p.i::text), 1, 16) end,
       m.metric, $2
     from (values ('chatgpt', 'api'), ('chatgpt', 'ui-vendor'), ('perplexity', 'ui-vendor'),
                  ('gemini', 'ui-vendor'), ('google-ai-overview', 'ui-vendor'),
                  ('google-ai-mode', 'ui-vendor')) e(engine, channel)
     cross join (values ('co-c1003659'), ('co-c1003654')) g(geo)
     cross join generate_series(0, 20) p(i)
     cross join (values ('completeness'), ('mean_length'), ('jaccard_runs'), ('names_rate')) m(metric)`,
    [day, sha("config")],
  );
  const { rows } = await owner.query<{ n: number }>(
    "select count(*)::int as n from public_panel.control_daily where day = $1",
    [day],
  );
  expect(rows[0]?.n).toBe(1008);
  const perRow = await bytesPerRow("control_daily", "day = $1", [day]);
  console.info(`control_daily bytes per row: ${perRow}, per canary day: ${perRow * 1008}`);
  expect(perRow).toBeLessThanOrEqual(CONTROL_DAILY_ROW_BUDGET);
});
