import { createHash, randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { getTestDatabaseUrl } from "@reranker/testing/neon";
import pg from "pg";
import { afterAll, beforeAll, expect, test } from "vitest";
import { runMigrations } from "../scripts/migrate";
import { runCatalogGate } from "./catalog-gate";
import { createScratchDatabase, type ScratchDatabase } from "./helpers";
import { onDatabase } from "./probe/database";

let scratch: ScratchDatabase;
let owner: pg.Client;
let system: pg.Client;
let app: pg.Client;
let measurementId: string;

const sha = (seed: string) => createHash("sha256").update(seed).digest();

async function connect(url: string): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  return client;
}

beforeAll(async () => {
  scratch = await createScratchDatabase("estimates");
  await runMigrations({
    url: scratch.url,
    migrationsFolder: fileURLToPath(new URL("../migrations", import.meta.url)),
    concurrentFolder: fileURLToPath(new URL("../migrations/concurrent", import.meta.url)),
  });
  owner = await connect(scratch.url);
  system = await connect(onDatabase(getTestDatabaseUrl("system"), scratch.name));
  app = await connect(onDatabase(getTestDatabaseUrl("app"), scratch.name));
  const { rows } = await system.query<{ id: string }>(
    `insert into public_panel.measurement_plans (purpose, ref_type, ref_id)
     values ('free-report', 'report', $1) returning id`,
    [randomUUID()],
  );
  measurementId = rows[0]?.id as string;
}, 180_000);

afterAll(async () => {
  await Promise.allSettled([owner?.end(), system?.end(), app?.end()]);
  await scratch?.drop();
});

type Row = {
  entityKey: string;
  scope: string;
  scopeKey: string | null;
  metric: string;
  level: string | null;
  sufficiency: string | null;
  lower: number;
  estimate: number;
  upper: number;
  successes: number;
  trials: number;
  seed: Buffer;
};

const score: Row = {
  entityKey: "place:ChIJN1t_tDeuEmsRUsoyG83frY4",
  scope: "overall",
  scopeKey: null,
  metric: "score",
  level: "on_the_list",
  sufficiency: "orientative",
  lower: 38,
  estimate: 47,
  upper: 56,
  successes: 94,
  trials: 200,
  seed: sha("seed"),
};

const insert = (over: Partial<Row> = {}) => {
  const r = { ...score, ...over };
  return system.query(
    `insert into public_panel.estimates (measurement_id, entity_key, scope, scope_key, metric,
       estimate, lower, upper, successes, trials, effective_trials, design_effect, level,
       sufficiency, methodology_hash, intent_set_hash, extractor_config_hash, seed, computed_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::int, $10::int, 1, $11, $12, $13, $14, $15, $16, now())`,
    [
      measurementId,
      r.entityKey,
      r.scope,
      r.scopeKey,
      r.metric,
      r.estimate,
      r.lower,
      r.upper,
      r.successes,
      r.trials,
      r.level,
      r.sufficiency,
      sha("methodology"),
      sha("intent-set"),
      sha("extractor"),
      r.seed,
    ],
  );
};

test("estimates pass the isolation catalog gate", async () => {
  const violations = await runCatalogGate(owner, new Set());
  expect(violations.filter((v) => v.table === "estimates")).toEqual([]);
});

test("app_tenant reads estimates and cannot write them", async () => {
  await expect(app.query("select 1 from public_panel.estimates limit 1")).resolves.toBeDefined();
  for (const sql of [
    "insert into public_panel.estimates default values",
    "update public_panel.estimates set computed_at = computed_at",
    "delete from public_panel.estimates",
  ]) {
    await expect(app.query(sql)).rejects.toMatchObject({ code: "42501" });
  }
});

test("no name or text column: only keys, numbers and SHA-256 digests", async () => {
  const { rows } = await owner.query<{ column_name: string; data_type: string }>(
    `select column_name, data_type from information_schema.columns
     where table_schema = 'public_panel' and table_name = 'estimates' and data_type in ('text', 'bytea')
     order by column_name`,
  );
  expect(rows.map((row) => `${row.column_name}:${row.data_type}`)).toEqual([
    "entity_key:text",
    "extractor_config_hash:bytea",
    "intent_set_hash:bytea",
    "methodology_hash:bytea",
    "scope_key:text",
    "seed:bytea",
  ]);
  await expect(insert({ seed: randomBytes(31) })).rejects.toMatchObject({ code: "23514" });
});

test("one row per key, an absent scope key included", async () => {
  await insert();
  await expect(insert()).rejects.toMatchObject({ code: "23505" });
  await insert({ scope: "engine", scopeKey: "gemini" });
  await expect(insert({ scope: "engine", scopeKey: "gemini" })).rejects.toMatchObject({
    code: "23505",
  });
});

test.each<[string, Partial<Row>]>([
  ["an overall row with a scope key", { scopeKey: "gemini" }],
  ["an engine row without one", { scope: "engine" }],
  ["a score without a level", { level: null }],
  ["a rate with a level", { entityKey: "*", metric: "names_entities_rate" }],
  ["a rate about one entity", { metric: "names_entities_rate", level: null, sufficiency: null }],
  ["an estimate outside its interval", { estimate: 57 }],
  ["more successes than trials", { successes: 201 }],
])("rejects %s", async (_, over) => {
  await expect(insert({ scope: "canonical", ...over })).rejects.toMatchObject({ code: "23514" });
});
