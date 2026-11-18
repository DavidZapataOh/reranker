import { createHash, randomBytes, randomUUID } from "node:crypto";
import { endPools, withSystem } from "@reranker/db";
import { cost } from "@reranker/schema";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, expect, test } from "vitest";
import {
  type ExtractionRow,
  findExtraction,
  insertExtraction,
  insertMentions,
  listDisagreements,
  type MentionRow,
} from "../src/store";

// Concurrency is real only with more connections than the default three of the system pool.
beforeAll(() => {
  process.env.DB_POOL_MAX = "12";
});
afterAll(() => endPools());

const hex = (seed: string) => createHash("sha256").update(seed).digest("hex");
const CONFIG = hex(`config:${randomUUID()}`);

async function capture(): Promise<string> {
  const id = `cap_${randomBytes(13).toString("hex").toUpperCase()}`;
  await withSystem("extraction.test", async (tx) => {
    const { rows } = await tx.execute<{ id: string }>(
      sql`insert into public_panel.measurement_plans (purpose, ref_type, ref_id, digest, slot_count)
          values ('contract-test', 'probe', ${randomUUID()}, ${Buffer.from(hex(id), "hex")}, 1)
          returning id`,
    );
    await tx.execute(
      sql`insert into public_panel.captures (id, measurement_id, slot_index, attempt, intent_set_id,
            intent_id, engine, channel, provider, mode, status, response_bytes, latency_ms,
            cost_amount_micros, cost_currency, envelope_sha256)
          values (${id}, ${rows[0]?.id}, 0, 1, 'is_0123456789abcdef',
            'odontologia.blanqueamiento-dental', 'chatgpt', 'ui-vendor', 'dataforseo', 'live',
            'succeeded', 1024, 900, 4000, 'USD', ${Buffer.from(hex(`envelope:${id}`), "hex")})`,
    );
  });
  return id;
}

const row = (captureId: string, overrides: Partial<ExtractionRow> = {}): ExtractionRow => ({
  captureId,
  configHash: CONFIG,
  outputsSha256: hex(`outputs:${captureId}`),
  answerKind: "names_entities",
  agreement: "agreed",
  judgeUsed: false,
  inputTokens: 1830,
  outputTokens: 412,
  cost: cost(1712, "USD"),
  latencyMs: 4210,
  disputedCount: 0,
  ...overrides,
});

const mention = (extractionId: string, overrides: Partial<MentionRow> = {}): MentionRow => ({
  extractionId,
  entityKey: "place:ChIJN1t_tDeuEmsRUsoyG83frY4",
  entityKind: "business",
  stance: "recommendation",
  sentiment: "positive",
  ordinal: 1,
  startOffset: 120,
  endOffset: 142,
  nameNorm: "clinica dental sonrisa",
  nameHmac: hex("clinica dental sonrisa"),
  placeId: "ChIJN1t_tDeuEmsRUsoyG83frY4",
  resolutionStatus: "resolved",
  resolutionMethod: "rules",
  resolutionScore: 0.94,
  isTarget: true,
  citedUrlHashes: [hex("https://sonrisa.example.co/"), hex("https://maps.google.com/?cid=1")],
  ...overrides,
});

test("extraction insert is idempotent per capture and config", async () => {
  const captureId = await capture();
  const first = await insertExtraction(row(captureId));
  expect(first.inserted).toBe(true);
  expect(await insertExtraction(row(captureId))).toEqual({ id: first.id, inserted: false });
  expect(await findExtraction(captureId, CONFIG)).toEqual({
    id: first.id,
    outputsSha256: hex(`outputs:${captureId}`),
  });
  expect(await findExtraction(captureId, hex("another config"))).toBeNull();
});

test("two workers inserting concurrently create one row", async () => {
  const captureId = await capture();
  const results = await Promise.all(
    Array.from({ length: 10 }, () => insertExtraction(row(captureId))),
  );
  expect(results.filter((result) => result.inserted)).toHaveLength(1);
  expect(new Set(results.map((result) => result.id)).size).toBe(1);
});

test("mentions are written once, cited URL digests included", async () => {
  const { id } = await insertExtraction(row(await capture()));
  const rows = [mention(id), mention(id, { startOffset: 300, endOffset: 318, ordinal: 2 })];
  expect(await insertMentions(rows)).toBe(2);
  expect(await insertMentions(rows)).toBe(0);
  expect(await insertMentions([])).toBe(0);
  const [stored] = await withSystem("extraction.test", (tx) =>
    tx.execute<{ bytes: number }>(
      sql`select octet_length(cited_url_hashes) as bytes from public_panel.mentions
          where extraction_id = ${id} and start_offset = 120`,
    ),
  ).then((result) => result.rows);
  expect(stored?.bytes).toBe(64);
});

test("a professional mention cannot store name_norm", async () => {
  const { id } = await insertExtraction(row(await capture()));
  await expect(
    insertMentions([mention(id, { entityKind: "professional", nameNorm: "ana gomez" })]),
  ).rejects.toMatchObject({ cause: { code: "23514" } });
  expect(await insertMentions([mention(id, { entityKind: "professional", nameNorm: null })])).toBe(
    1,
  );
});

test("the disagreement queue lists disputed extractions since a date, oldest first", async () => {
  // The database clock, which stamps created_at, not this machine's.
  const since = await withSystem("extraction.test", (tx) =>
    tx.execute<{ now: string }>(sql`select now()::text as now`),
  ).then((result) => new Date(result.rows[0]?.now as string));
  const agreed = await capture();
  const disputed = [await capture(), await capture(), await capture()];
  await insertExtraction(row(agreed));
  for (const [index, captureId] of disputed.entries()) {
    await insertExtraction(
      row(captureId, { agreement: "adjudicated", judgeUsed: true, disputedCount: index + 1 }),
    );
  }
  const queue = await listDisagreements(since, 100);
  const ours = queue.filter((entry) => [agreed, ...disputed].includes(entry.captureId));
  expect(ours).toEqual(
    disputed.map((captureId, index) => ({
      captureId,
      outputsSha256: hex(`outputs:${captureId}`),
      disputedCount: index + 1,
    })),
  );
  expect(await listDisagreements(since, 1)).toHaveLength(1);
  expect(
    (await listDisagreements(new Date(Date.now() + 60_000), 100)).filter((entry) =>
      disputed.includes(entry.captureId),
    ),
  ).toEqual([]);
});
