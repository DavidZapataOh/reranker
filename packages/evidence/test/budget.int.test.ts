import { randomBytes, randomUUID } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { endPools, withSystem } from "@reranker/db";
import { expectNoSeqScanOn, explain } from "@reranker/testing/db";
import { getTestDatabaseUrl } from "@reranker/testing/neon";
import type { CaptureId } from "@reranker/verify/format";
import { type SQL, sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { bundleQuery, sealSummariesQuery } from "../src/bundle";
import { resetEvidenceEnv } from "../src/env";
import { integrate, pendingEntriesQuery } from "../src/log/integrate";
import { proofHashesQuery, proofHashIndexes } from "../src/log/proofs";
import { storedHashIndex } from "../src/log/tlog";
import { latestNormalizedQuery, sealCapture, sealPlan } from "../src/seal";
import { loadSigner } from "../src/signer";
import { newCaptureId, sealInputFor } from "./support/capture-input";
import { previewEnv } from "./support/evidence-env";
import { localSigner } from "./support/local-signer";

vi.mock("../src/signer", () => ({ loadSigner: vi.fn() }));
vi.mock("@reranker/jobs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@reranker/jobs")>()),
  enqueue: vi.fn(async () => ({ jobId: "evidence.integrate:test", created: true })),
}));
// Only the tiles suite publishes; the batches integrated here stay unpublished.
vi.mock("../src/log/tiles", () => ({
  publishPendingBatches: vi.fn(async () => ({ published: [] })),
}));

const ORIGIN = previewEnv.EVIDENCE_LOG_ORIGIN;
const REPORT_CAPTURES = 200;
const SEED_ROWS = 10_000;
// The columns a capture row carries for the log; the rest of the row is the capture plan's share.
const CAPTURE_EVIDENCE_COLUMNS = ["envelope_sha256", "normalized_sha256", "log_index"];
const signers = {
  capture: localSigner("rr-capture-preview-1-ed25519"),
  log: localSigner("rr-log-preview-1"),
};

const dialect = new PgDialect();
const query = (q: SQL) => dialect.sqlToQuery(q);

// R2 is not what this suite measures, so the artifacts land in memory.
const r2 = new Map<string, Uint8Array<ArrayBuffer>>();
async function memoryR2(request: Request): Promise<Response> {
  const key = new URL(request.url).pathname.split("/").slice(2).join("/");
  if (request.method === "PUT") {
    if (r2.has(key)) return new Response(null, { status: 412 });
    r2.set(key, new Uint8Array(gunzipSync(new Uint8Array(await request.arrayBuffer()))));
    return new Response(null, { status: 200 });
  }
  const body = r2.get(key);
  return body ? new Response(body) : new Response(null, { status: 404 });
}

let owner: pg.Client;

beforeAll(async () => {
  for (const [name, value] of Object.entries(previewEnv)) vi.stubEnv(name, value);
  vi.stubEnv("VERCEL_REGION", "iad1");
  vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "fedcba9876543210fedcba9876543210fedcba98");
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => memoryR2(new Request(input, init))),
  );
  resetEvidenceEnv();
  vi.mocked(loadSigner).mockImplementation(async (purpose) => signers[purpose]);
  owner = new pg.Client({ connectionString: getTestDatabaseUrl("migrations") });
  await owner.connect();
});

afterAll(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  resetEvidenceEnv();
  await owner?.end();
  await endPools();
});

type Report = { measurementId: string; captureIds: string[] };

/** What one free report seals: its plan, then every capture with its row, in one transaction. */
async function sealAndPersistReport(n: number): Promise<Report> {
  return withSystem("evidence.test", async (tx) => {
    const {
      rows: [plan],
    } = await tx.execute<{ id: string }>(sql`
      insert into public_panel.measurement_plans (purpose, ref_type, ref_id, digest, slot_count)
      values ('contract-test', 'probe', ${randomUUID()}, ${randomBytes(32)}, ${n})
      returning id`);
    if (!plan) throw new Error("No measurement plan was inserted");
    const planBytes = new TextEncoder().encode(JSON.stringify({ measurement: plan.id, slots: n }));
    await sealPlan({ measurementId: plan.id, planBytes }, { tx });
    const seals = [];
    for (let slot = 0; slot < n; slot++) {
      seals.push(await sealCapture(sealInputFor(newCaptureId()), { tx }));
    }
    await tx.execute(sql`
      insert into public_panel.captures (id, measurement_id, slot_index, attempt, intent_set_id,
        intent_id, engine, channel, provider, mode, status, response_bytes, latency_ms,
        cost_amount_micros, cost_currency, envelope_sha256, normalized_sha256, parser_version)
      select v.id, ${plan.id}, v.slot - 1, 1, 'is_0123456789abcdef',
        'odontologia.blanqueamiento-dental', 'chatgpt', 'ui-vendor', 'dataforseo', 'live',
        'succeeded', 2048, 900, 4000, 'USD', decode(v.envelope, 'hex'), decode(v.normalized, 'hex'), 1
      from unnest(${sql.param(seals.map((s) => s.captureId))}::text[],
                  ${sql.param(seals.map((s) => s.envelopeSha256))}::text[],
                  ${sql.param(seals.map((s) => s.normalizedSha256))}::text[])
        with ordinality as v(id, envelope, normalized, slot)`);
    return { measurementId: plan.id, captureIds: seals.map((s) => s.captureId) };
  });
}

async function integrateAll(report: Report): Promise<void> {
  for (let runs = 0; runs < 20; runs++) {
    const { rows } = await owner.query<{ pending: number }>(
      "select count(*)::int as pending from public_panel.captures where id = any($1) and log_index is null",
      [report.captureIds],
    );
    if (rows[0]?.pending === 0) return;
    await integrate(ORIGIN);
  }
  throw new Error("The report's captures were never integrated");
}

// Sizes as Postgres stores them, as in the db package's budget tests: a heap row plus its line
// pointer, and per row one entry in every index (8-byte tuple header and key, aligned to 8, plus
// its line pointer). An index whose predicate a row fails holds no entry for it.
async function indexBytes(
  table: string,
  scope: string,
  values: unknown[],
  columns?: string[],
): Promise<number> {
  const { rows: indexes } = await owner.query<{ columns: string[]; pred: string }>(
    `select array(select a.attname::text from unnest(i.indkey) k
             join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k) as columns,
       coalesce(pg_get_expr(i.indpred, i.indrelid), 'true') as pred
     from pg_index i where i.indrelid = $1::regclass`,
    [table],
  );
  const counted = indexes.filter((i) => !columns || i.columns.some((c) => columns.includes(c)));
  expect(counted.length).toBeGreaterThan(0);
  let total = 0;
  for (const index of counted) {
    const key = index.columns.map((column) => `coalesce(pg_column_size(${column}), 0)`).join(" + ");
    const { rows } = await owner.query<{ b: number }>(
      `select coalesce(sum(4 + ((8 + ${key} + 7) / 8) * 8), 0)::int as b
       from ${table} where ${scope} and (${index.pred})`,
      values,
    );
    total += rows[0]?.b ?? 0;
  }
  return total;
}

async function rowBytes(table: string, scope: string, values: unknown[]): Promise<number> {
  const { rows } = await owner.query<{ b: number }>(
    `select coalesce(sum(pg_column_size(t.*) + 4), 0)::int as b from ${table} t where ${scope}`,
    values,
  );
  return (rows[0]?.b ?? 0) + (await indexBytes(table, scope, values));
}

/**
 * The bytes the log adds for one report: the evidence columns of its captures and their index
 * entries, its plan entry, and every batch that holds any of its entries.
 */
async function evidenceShareOf(report: Report): Promise<number> {
  const captures: unknown[] = [report.captureIds];
  const columns = CAPTURE_EVIDENCE_COLUMNS.map((c) => `coalesce(pg_column_size(${c}), 0)`);
  const { rows: heap } = await owner.query<{ b: number }>(
    `select coalesce(sum(${columns.join(" + ")}), 0)::int as b
     from public_panel.captures where id = any($1)`,
    captures,
  );
  const captureColumns = heap[0]?.b ?? 0;
  const captureIndexes = await indexBytes(
    "public_panel.captures",
    "id = any($1)",
    captures,
    CAPTURE_EVIDENCE_COLUMNS,
  );
  const planEntry = await rowBytes(
    "public_panel.evidence_entries",
    "ref = $1 and kind = 'plan' and revision = 0",
    [report.measurementId],
  );
  const { rows: span } = await owner.query<{ first: string; last: string }>(
    `select min(log_index) as first, max(log_index) as last from (
       select log_index from public_panel.captures where id = any($1)
       union all
       select log_index from public_panel.evidence_entries where ref = $2 and kind = 'plan'
     ) e`,
    [report.captureIds, report.measurementId],
  );
  const batches = await rowBytes(
    "public_panel.evidence_batches",
    "origin = $1 and first_index <= $3 and tree_size > $2",
    [ORIGIN, span[0]?.first, span[0]?.last],
  );
  // The stored hashes of subtrees of 256 entries and more appended with the report's entries.
  const treeHashes = await rowBytes(
    "public_panel.evidence_tree_hashes",
    "origin = $1 and stored_index >= $2 and stored_index < $3",
    [
      ORIGIN,
      storedHashIndex(0, Number(span[0]?.first)),
      storedHashIndex(0, Number(span[0]?.last) + 1),
    ],
  );
  console.info(
    `evidence bytes of a ${report.captureIds.length}-capture report: capture columns ${captureColumns}, ` +
      `their index entries ${captureIndexes}, plan entry ${planEntry}, batches ${batches}, ` +
      `tree hashes ${treeHashes}`,
  );
  return captureColumns + captureIndexes + planEntry + batches + treeHashes;
}

test("the evidence share of one 200-capture report stays within its budget", {
  timeout: 180_000,
}, async () => {
  const report = await sealAndPersistReport(REPORT_CAPTURES);
  await integrateAll(report);
  const share = await evidenceShareOf(report);
  console.info(`evidence bytes per ${REPORT_CAPTURES}-capture report: ${share}`);
  // Each capture carries two 32-byte digests and a log index, plus that index's unique entry:
  // 94 bytes, 18.8 KB a report, before the plan entry and its batch (at most 1 KB).
  expect(share).toBeLessThanOrEqual(20 * 1024);
});

// Seeded and analyzed inside a transaction that is rolled back, so no other suite sees the rows
// and the planner sees the statistics of tables that size. Runs after the integration above: the
// pending query locks every pending row until the rollback.
describe(`index plans with ${SEED_ROWS.toLocaleString("en")} rows`, () => {
  const seedOrigin = `explain.invalid/${randomUUID()}/captures/2026`;
  // Far above any index a test log reaches, and apart, so the seeded rows collide with none.
  const CAPTURE_INDEX_BASE = 9_000_000_000_000;
  const ENTRY_INDEX_BASE = 9_100_000_000_000;
  let sampleCaptureId: CaptureId;

  beforeAll(async () => {
    await owner.query("begin");
    const {
      rows: [plan],
    } = await owner.query<{ id: string }>(
      `insert into public_panel.measurement_plans (purpose, ref_type, ref_id, digest, slot_count)
       values ('contract-test', 'probe', $1, $2, 1) returning id`,
      [randomUUID(), randomBytes(32)],
    );
    const prefix = newCaptureId().slice(0, 10);
    await owner.query(
      `insert into public_panel.captures (id, measurement_id, slot_index, attempt, intent_set_id,
         intent_id, engine, channel, provider, mode, status, response_bytes, latency_ms,
         cost_amount_micros, cost_currency, envelope_sha256, normalized_sha256, parser_version,
         log_index)
       select $2::text || lpad(g::text, 20, '0'), $1, g, 1, 'is_0123456789abcdef',
         'odontologia.blanqueamiento-dental', 'chatgpt', 'ui-vendor', 'dataforseo', 'live',
         'succeeded', 2048, 900, 4000, 'USD', sha256(convert_to($2::text || g, 'UTF8')),
         sha256(convert_to('n' || $2::text || g, 'UTF8')), 1,
         case when g % 10 = 0 then null else $3::bigint + g end
       from generate_series(1, $4::int) g`,
      [plan?.id, prefix, CAPTURE_INDEX_BASE, SEED_ROWS],
    );
    await owner.query(
      `insert into public_panel.evidence_entries (ref, kind, revision, envelope_sha256,
         normalized_sha256, log_index)
       select $1::text || lpad(g::text, 20, '0'), 'reparse', 2, sha256(convert_to('r' || $1::text || g, 'UTF8')),
         sha256(convert_to('rn' || $1::text || g, 'UTF8')),
         case when g % 10 = 0 then null else $2::bigint + g end
       from generate_series(1, $3::int) g`,
      [prefix, ENTRY_INDEX_BASE, SEED_ROWS],
    );
    // Published batches over the seeded captures' indexes, each with its OpenTimestamps proof
    // (the newest still pending) and a DigiCert token.
    await owner.query(
      `insert into public_panel.evidence_batches (origin, tree_size, first_index, root, frontier,
         checkpoint_note, published_at)
       select $1::text, $3::bigint + g * 10, $3::bigint + g * 10 - 10,
         sha256(convert_to('root' || g, 'UTF8')), sha256(convert_to('frontier' || g, 'UTF8')),
         $1::text || E'\\n' || g * 10 || E'\\n', now()
       from generate_series(1, $2::int) g`,
      [seedOrigin, SEED_ROWS, CAPTURE_INDEX_BASE],
    );
    await owner.query(
      `insert into public_panel.timestamp_anchors (origin, tree_size, kind, provider, status,
         proof, bitcoin_height, attested_at)
       select $1::text, $3::bigint + g * 10, k.kind, k.provider,
         case when k.kind = 'ots' and g > $2::int - 10 then 'pending' else 'confirmed' end,
         sha256(convert_to(k.provider || g, 'UTF8')),
         case when k.kind = 'ots' and g <= $2::int - 10 then 900000 + g end,
         case when k.kind = 'ots' and g <= $2::int - 10 then now() end
       from generate_series(1, $2::int) g,
         (values ('ots', 'ots-calendars'), ('rfc3161', 'digicert')) as k(kind, provider)`,
      [seedOrigin, SEED_ROWS, CAPTURE_INDEX_BASE],
    );
    await owner.query(
      `insert into public_panel.evidence_tree_hashes (origin, stored_index, hash)
       select $1::text, g, sha256(convert_to('node' || g, 'UTF8'))
       from generate_series(1, $2::int) g`,
      [seedOrigin, SEED_ROWS],
    );
    for (const table of [
      "captures",
      "evidence_entries",
      "evidence_batches",
      "timestamp_anchors",
      "evidence_tree_hashes",
    ]) {
      await owner.query(`analyze public_panel.${table}`);
    }
    sampleCaptureId = `${prefix}${"4242".padStart(20, "0")}` as CaptureId;
  });

  afterAll(async () => {
    await owner.query("rollback");
  });

  test("the pending entries integrate reads walk both partial indexes", async () => {
    const { sql: text, params } = query(pendingEntriesQuery());
    const plan = await explain(owner, text, params);
    expectNoSeqScanOn(plan, "public_panel.captures");
    expectNoSeqScanOn(plan, "public_panel.evidence_entries");
  });

  test("the latest normalized reading of a capture uses the primary keys", async () => {
    const { sql: text, params } = query(latestNormalizedQuery(sampleCaptureId));
    const plan = await explain(owner, text, params);
    expectNoSeqScanOn(plan, "public_panel.captures");
    expectNoSeqScanOn(plan, "public_panel.evidence_entries");
  });

  test("a bundle finds its capture, its batches and their anchors through indexes", async () => {
    const { sql: text, params } = query(bundleQuery(sampleCaptureId, seedOrigin));
    const plan = await explain(owner, text, params);
    for (const table of ["captures", "evidence_batches", "timestamp_anchors"]) {
      expectNoSeqScanOn(plan, `public_panel.${table}`);
    }
  });

  test("a bundle's proofs read entries by log index and tree hashes by key", async () => {
    const index = CAPTURE_INDEX_BASE + 4242;
    const treeSize = CAPTURE_INDEX_BASE + 4250;
    const indexes = await proofHashIndexes(treeSize, index, treeSize + 300);
    const { sql: text, params } = query(proofHashesQuery(seedOrigin, indexes));
    const plan = await explain(owner, text, params);
    for (const table of ["captures", "evidence_entries", "evidence_tree_hashes"]) {
      expectNoSeqScanOn(plan, `public_panel.${table}`);
    }
  });

  test("seal summaries find each capture's batch and confirmed anchor through indexes", async () => {
    const { sql: text, params } = query(sealSummariesQuery([sampleCaptureId], seedOrigin));
    const plan = await explain(owner, text, params);
    for (const table of ["captures", "evidence_batches", "timestamp_anchors"]) {
      expectNoSeqScanOn(plan, `public_panel.${table}`);
    }
  });
});
