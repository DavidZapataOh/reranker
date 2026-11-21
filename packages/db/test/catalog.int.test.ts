import { createHash, randomBytes } from "node:crypto";
import { SeedCatalogFile } from "@reranker/schema/measurement";
import { expectNoSeqScanOn, explain } from "@reranker/testing/db";
import { getTestDatabaseUrl } from "@reranker/testing/neon";
import pg from "pg";
import { afterAll, beforeAll, expect, test } from "vitest";
import { endPools } from "../src/client";
import { seedCatalog } from "../src/seed/catalog";
import miniJson from "./fixtures/catalog-mini.json" with { type: "json" };

const TABLES = [
  "prompt_sets",
  "categories",
  "intents",
  "personas",
  "paraphrases",
  "intent_sets",
] as const;

const sha = (seed: string) => createHash("sha256").update(seed).digest("hex");
const catalog = SeedCatalogFile.parse(miniJson);
// A version of its own keeps this run apart from any other seed on the shared test database.
const version = `2026.11.${randomBytes(4).readUInt32BE()}`;
const mini = { version, catalog, contentHash: sha(version), merkleRoot: sha(`${version}/root`) };

let owner: pg.Client;
let app: pg.Client;

async function connect(url: string): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  return client;
}

beforeAll(async () => {
  owner = await connect(getTestDatabaseUrl("migrations"));
  app = await connect(getTestDatabaseUrl("app"));
});

afterAll(async () => {
  try {
    for (const table of ["paraphrases", "personas", "intents"]) {
      await owner?.query(`delete from public_panel.${table} where prompt_set = $1`, [version]);
    }
    await owner?.query("delete from public_panel.prompt_sets where version = $1", [version]);
  } finally {
    await Promise.allSettled([owner?.end(), app?.end(), endPools()]);
  }
});

async function count(table: string): Promise<number> {
  const column = table === "prompt_sets" ? "version" : "prompt_set";
  const { rows } = await owner.query<{ n: number }>(
    `select count(*)::int as n from public_panel.${table} where ${column} = $1`,
    [version],
  );
  return rows[0]?.n ?? 0;
}

test("seeding twice leaves one copy", async () => {
  const first = await seedCatalog(mini);
  const second = await seedCatalog(mini);
  expect(first.inserted).toBeGreaterThan(0);
  expect(second.inserted).toBe(0);
  expect(await count("prompt_sets")).toBe(1);
  expect(await count("intents")).toBe(catalog.intents.length);
  expect(await count("personas")).toBe(catalog.personas.length);
  expect(await count("paraphrases")).toBe(catalog.paraphrases.length);
  const { rows } = await owner.query<{ n: number }>(
    "select count(*)::int as n from public_panel.categories where key = any($1)",
    [catalog.categories.map((c) => c.key)],
  );
  expect(rows[0]?.n).toBe(catalog.categories.length);
});

test("the seed row records its hashes and every persona-or-none variant", async () => {
  await seedCatalog(mini);
  const { rows } = await owner.query<{ content: string; root: string; variants: number }>(
    `select encode(content_hash, 'hex') as content, encode(merkle_root, 'hex') as root,
       variant_count as variants
     from public_panel.prompt_sets where version = $1`,
    [version],
  );
  // (3 + 2) dental paraphrases × (2 personas + none) + 1 online paraphrase × (1 persona + none).
  expect(rows[0]).toEqual({ content: mini.contentHash, root: mini.merkleRoot, variants: 17 });
});

test("a paraphrase of an intent the seed does not hold is rejected and nothing is written", async () => {
  const other = `${version}9`;
  const orphan = { ...catalog.paraphrases[0], paraphraseId: "x", intentId: "hotel.best_hotel" };
  const broken = SeedCatalogFile.parse({
    ...catalog,
    paraphrases: [...catalog.paraphrases, orphan],
  });
  await expect(
    seedCatalog({ ...mini, version: other, catalog: broken, contentHash: sha(other) }),
  ).rejects.toThrow();
  const { rows } = await owner.query<{ n: number }>(
    "select count(*)::int as n from public_panel.prompt_sets where version = $1",
    [other],
  );
  expect(rows[0]?.n).toBe(0);
});

test.each(TABLES)("app role can read but not write %s", async (table) => {
  await expect(app.query(`select 1 from public_panel.${table} limit 1`)).resolves.toBeDefined();
  await expect(app.query(`insert into public_panel.${table} default values`)).rejects.toMatchObject(
    { code: "42501" },
  );
});

const REUSE = `
  select set_id, artifact_sha256 from public_panel.intent_sets
  where category_key = $1 and scope = $2 and register_profile = $3 and generator_config_hash = $4
    and language = 'es' and created_at > now() - interval '30 days'
  order by created_at desc limit 1`;

// Ten thousand generated sets across 300 categories, both profiles and three generator configs.
const SEED_INTENT_SETS = `
  insert into public_panel.intent_sets (set_id, kind, version, category_key, scope,
    register_profile, generator_config_hash, generators, content_hash, merkle_root,
    artifact_sha256, variant_count, created_at)
  select 'is_' || left(encode(sha256(g::text::bytea), 'hex'), 16), 'generated',
    '2026-11-18.' || g, 'gen:places:type' || (g % 300), 'local',
    (case when g % 2 = 0 then 'co' else 'neutral' end)::public_panel.register_profile,
    sha256(('cfg' || g % 3)::bytea), 2, sha256(g::text::bytea), sha256(('root' || g)::bytea),
    sha256(('artifact' || g)::bytea), 240, now() - make_interval(days => g % 60)
  from generate_series(1, 10000) g`;

test("reuse lookup uses the index", async () => {
  await owner.query("begin");
  try {
    await owner.query(SEED_INTENT_SETS);
    await owner.query("analyze public_panel.intent_sets");
    const plan = await explain(owner, REUSE, [
      "gen:places:type7",
      "local",
      "neutral",
      Buffer.from(sha("cfg1"), "hex"),
    ]);
    expectNoSeqScanOn(plan, "public_panel.intent_sets");
  } finally {
    await owner.query("rollback");
  }
});

test("an intent_sets row stays under 256 bytes", async () => {
  await owner.query("begin");
  try {
    await owner.query(SEED_INTENT_SETS);
    const { rows } = await owner.query<{ avg: number; max: number }>(
      `select avg(pg_column_size(t.*))::int as avg, max(pg_column_size(t.*))::int as max
       from public_panel.intent_sets t`,
    );
    console.info(`intent_sets row bytes: ${JSON.stringify(rows[0])}`);
    expect(rows[0]?.max).toBeLessThan(256);
  } finally {
    await owner.query("rollback");
  }
});

test("an intent set id must be is_ and 16 hex digits", async () => {
  await owner.query("begin");
  try {
    await expect(
      owner.query(
        `insert into public_panel.intent_sets (set_id, kind, version, category_key, scope,
           register_profile, generators, content_hash, merkle_root, variant_count)
         values ('is_nothex', 'template', 't', 'gen:places:bakery', 'local', 'co', 0,
           sha256('a'), sha256('b'), 48)`,
      ),
    ).rejects.toMatchObject({ code: "23514" });
  } finally {
    await owner.query("rollback");
  }
});
