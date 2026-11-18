import { createHash, randomBytes, randomUUID } from "node:crypto";
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
  extractions: "created_at",
  mentions: "start_offset",
  places: "decided_at",
};
const TABLES = Object.keys(NOOP_COLUMN);

// Row plus index entries. A report keeps one extraction per answer and only the mentions of the
// entities it shows, so its total is 200 × the first plus its kept mentions × the second.
const EXTRACTION_ROW_BUDGET = 300;
const MENTION_ROW_BUDGET = 330;

let scratch: ScratchDatabase;
let owner: pg.Client;
let system: pg.Client;
let app: pg.Client;
let measurementId: string;

const sha = (seed: string) => createHash("sha256").update(seed).digest();
const CONFIG = sha("extractor-config-v1");

async function connect(url: string): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  return client;
}

beforeAll(async () => {
  scratch = await createScratchDatabase("extraction");
  await runMigrations({
    url: scratch.url,
    migrationsFolder: fileURLToPath(new URL("../migrations", import.meta.url)),
    concurrentFolder: fileURLToPath(new URL("../migrations/concurrent", import.meta.url)),
  });
  owner = await connect(scratch.url);
  system = await connect(onDatabase(getTestDatabaseUrl("system"), scratch.name));
  app = await connect(onDatabase(getTestDatabaseUrl("app"), scratch.name));
  const { rows } = await system.query<{ id: string }>(
    `insert into public_panel.measurement_plans (purpose, ref_type, ref_id, digest, slot_count)
     values ('free-report', 'report', $1, $2, 200) returning id`,
    [randomUUID(), sha(randomUUID())],
  );
  measurementId = rows[0]?.id as string;
}, 180_000);

afterAll(async () => {
  await Promise.allSettled([owner?.end(), system?.end(), app?.end()]);
  await scratch?.drop();
});

const sys = (sql: string, values?: unknown[]) => system.query(sql, values);
let slot = 0;

async function insertCapture(): Promise<string> {
  // Same length as cap_ + ULID, so row sizes match production.
  const id = `cap_${randomBytes(13).toString("hex").toUpperCase()}`;
  await sys(
    `insert into public_panel.captures (id, measurement_id, slot_index, attempt, intent_set_id,
       intent_id, engine, channel, provider, mode, status, response_bytes, latency_ms,
       cost_amount_micros, cost_currency, envelope_sha256)
     values ($1, $2, $3, 1, 'is_0123456789abcdef', 'odontologia.blanqueamiento-dental', 'gemini',
       'ui-vendor', 'dataforseo', 'live', 'succeeded', 48213, 11834, 4000, 'USD', $4)`,
    [id, measurementId, slot++, sha(id)],
  );
  return id;
}

async function insertExtraction(captureId: string, disputed = 0): Promise<string> {
  const { rows } = await sys(
    `insert into public_panel.extractions (capture_id, config_hash, answer_kind, agreement,
       judge_used, input_tokens, output_tokens, cost_amount_micros, cost_currency, latency_ms,
       outputs_sha256, disputed_count)
     values ($1, $2, 'names_entities', $3, $4, 1830, 412, 1712, 'USD', 4210, $5, $6)
     returning id`,
    [
      captureId,
      CONFIG,
      disputed > 0 ? "adjudicated" : "agreed",
      disputed > 0,
      sha(captureId),
      disputed,
    ],
  );
  return rows[0]?.id as string;
}

type Mention = {
  start: number;
  kind?: string;
  stance?: string;
  ordinal?: number | null;
  nameNorm?: string | null;
  hmac?: Buffer;
  cited?: Buffer;
};

// A resolved business mention as the report keeps it: a place key, its id and one cited URL.
function insertMention(extractionId: string, m: Mention) {
  // Real place ids are 27 characters.
  const placeId = `ChIJ${randomBytes(18).toString("base64url").slice(0, 23)}`;
  return sys(
    `insert into public_panel.mentions (extraction_id, entity_key, entity_kind, stance, ordinal,
       start_offset, end_offset, sentiment, name_norm, name_hmac, place_id, resolution_status,
       resolution_method, resolution_score, is_target, cited_url_hashes)
     values ($1, $2, $3, $4, $5, $6, $7, 'positive', $8, $9, $10, 'resolved', 'rules', 0.94,
       false, $11)`,
    [
      extractionId,
      `place:${placeId}`,
      m.kind ?? "business",
      m.stance ?? "recommendation",
      m.ordinal === undefined ? 1 : m.ordinal,
      m.start,
      m.start + 24,
      m.nameNorm === undefined ? "clinica dental sonrisa" : m.nameNorm,
      m.hmac ?? sha(`name:${m.start}`),
      placeId,
      m.cited ?? sha(`url:${m.start}`),
    ],
  );
}

test("the three tables pass the isolation catalog gate", async () => {
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

test("no column can hold a raw name, address, response text or Places content", async () => {
  const { rows } = await owner.query<{ column_name: string }>(
    `select column_name from information_schema.columns
     where table_schema = 'public_panel' and table_name = any($1)`,
    [TABLES],
  );
  const columns = rows.map((row) => row.column_name);
  for (const raw of [
    "name",
    "display_name",
    "address",
    "formatted_address",
    "markdown",
    "quote",
    "website_uri",
    "opening_hours",
    "outputs_object_key",
  ]) {
    expect(columns).not.toContain(raw);
  }
});

test("every bytea column is a SHA-256 or HMAC digest with a length check", async () => {
  const { rows } = await owner.query<{ table_name: string; column_name: string }>(
    `select table_name, column_name from information_schema.columns
     where table_schema = 'public_panel' and table_name = any($1) and data_type = 'bytea'
     order by 1, 2`,
    [TABLES],
  );
  expect(rows.map((row) => `${row.table_name}.${row.column_name}`)).toEqual([
    "extractions.config_hash",
    "extractions.outputs_sha256",
    "mentions.cited_url_hashes",
    "mentions.name_hmac",
    "places.config_hash",
    "places.name_hmac",
  ]);
  const capture = await insertCapture();
  await expect(
    sys(
      `insert into public_panel.extractions (capture_id, config_hash, answer_kind, agreement,
         judge_used, input_tokens, output_tokens, cost_amount_micros, cost_currency, latency_ms,
         outputs_sha256)
       values ($1, $2, 'no_entities', 'agreed', false, 1, 1, 0, 'USD', 1, $3)`,
      [capture, Buffer.from(CONFIG.toString("hex")), sha("x")],
    ),
  ).rejects.toMatchObject({ code: "23514" });
  const extraction = await insertExtraction(capture);
  await expect(
    insertMention(extraction, { start: 0, hmac: randomBytes(31) }),
  ).rejects.toMatchObject({ code: "23514" });
  await expect(
    insertMention(extraction, { start: 0, cited: randomBytes(48) }),
  ).rejects.toMatchObject({ code: "23514" });
  await insertMention(extraction, { start: 0, cited: Buffer.concat([sha("a"), sha("b")]) });
});

test("a professional mention keeps only the name HMAC", async () => {
  const extraction = await insertExtraction(await insertCapture());
  await expect(
    insertMention(extraction, { start: 0, kind: "professional", nameNorm: "ana gomez" }),
  ).rejects.toMatchObject({ code: "23514" });
  await insertMention(extraction, { start: 0, kind: "professional", nameNorm: null });
});

test("only recommendations carry an ordinal, from 1", async () => {
  const extraction = await insertExtraction(await insertCapture());
  await expect(
    insertMention(extraction, { start: 0, stance: "incidental", ordinal: 2 }),
  ).rejects.toMatchObject({ code: "23514" });
  await expect(insertMention(extraction, { start: 0, ordinal: 0 })).rejects.toMatchObject({
    code: "23514",
  });
  await insertMention(extraction, { start: 0, stance: "incidental", ordinal: null });
  await expect(insertMention(extraction, { start: 0 })).rejects.toMatchObject({ code: "23505" });
});

test("one extraction per capture and config; its mentions go with it", async () => {
  const capture = await insertCapture();
  const extraction = await insertExtraction(capture);
  await expect(insertExtraction(capture)).rejects.toMatchObject({ code: "23505" });
  await insertMention(extraction, { start: 10 });
  await owner.query("delete from public_panel.extractions where id = $1", [extraction]);
  const { rows } = await owner.query(
    "select 1 from public_panel.mentions where extraction_id = $1",
    [extraction],
  );
  expect(rows).toEqual([]);
});

test("a cached place decision has a place id exactly when the outcome is a place", async () => {
  const insert = (outcome: string, placeId: string | null) =>
    sys(
      `insert into public_panel.places (name_hmac, geo_key, category_key, config_hash, outcome,
         place_id, score, method)
       values ($1, 'co-c1001', 'odontologia', $2, $3, $4, 0.91, 'rules')`,
      [sha(randomUUID()), CONFIG, outcome, placeId],
    );
  await expect(insert("place", null)).rejects.toMatchObject({ code: "23514" });
  await expect(insert("chain", "ChIJx")).rejects.toMatchObject({ code: "23514" });
  await insert("place", "ChIJN1t_tDeuEmsRUsoyG83frY4");
  await insert("unresolvable", null);
});

// Sizes as Postgres stores them: each heap row plus its line pointer, and one entry per row in
// every index (8-byte tuple header and key, aligned to 8, plus its line pointer).
async function bytesPerRow(table: string, scope: string, values: unknown[]): Promise<number> {
  const { rows: count } = await owner.query<{ n: number; b: number }>(
    `select count(*)::int as n, coalesce(sum(pg_column_size(t.*) + 4), 0)::int as b
     from public_panel.${table} t where ${scope}`,
    values,
  );
  let bytes = count[0]?.b ?? 0;
  const { rows: indexes } = await owner.query<{ columns: string[]; pred: string }>(
    `select array(select a.attname::text from unnest(i.indkey) k
             join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k) as columns,
       coalesce(pg_get_expr(i.indpred, i.indrelid), 'true') as pred
     from pg_index i where i.indrelid = $1::regclass`,
    [`public_panel.${table}`],
  );
  for (const index of indexes) {
    const key = index.columns.map((column) => `pg_column_size(${column})`).join(" + ");
    const { rows } = await owner.query<{ b: number }>(
      `select coalesce(sum(4 + ((8 + ${key} + 7) / 8) * 8), 0)::int as b
       from public_panel.${table} where ${scope} and (${index.pred})`,
      values,
    );
    bytes += rows[0]?.b ?? 0;
  }
  return bytes / (count[0]?.n ?? 1);
}

test("an extraction and each mention the report keeps stay within their row budgets", async () => {
  const ids: string[] = [];
  for (let answer = 0; answer < 200; answer++) {
    const extraction = await insertExtraction(await insertCapture(), answer % 10 === 0 ? 1 : 0);
    ids.push(extraction);
    await insertMention(extraction, { start: 120, ordinal: 1 });
    await insertMention(extraction, { start: 480, ordinal: 2 });
  }
  const extraction = await bytesPerRow("extractions", "id = any($1)", [ids]);
  const mention = await bytesPerRow("mentions", "extraction_id = any($1)", [ids]);
  console.info(
    `bytes per extraction ${extraction}, per mention ${mention}; a 200-answer report with two kept mentions per answer: ${Math.round((200 * extraction + 400 * mention) / 1024)} KB`,
  );
  expect(extraction).toBeLessThanOrEqual(EXTRACTION_ROW_BUDGET);
  expect(mention).toBeLessThanOrEqual(MENTION_ROW_BUDGET);
});
