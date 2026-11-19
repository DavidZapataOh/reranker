import { createHash, randomBytes, randomUUID } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { endPools, withSystem } from "@reranker/db";
import {
  type CaptureId,
  type EvidenceBundleV1,
  EvidenceBundleV1Schema,
  envelopeBytes,
  leafHash,
  nodeHash,
} from "@reranker/verify/format";
import { type SQL, sql } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { buildBundle, getSealSummaries, verifyUrl } from "../src/bundle";
import { resetEvidenceEnv } from "../src/env";
import { parseCheckpoint } from "../src/log/checkpoint";
import { integrate } from "../src/log/integrate";
import { publishPendingBatches } from "../src/log/tiles";
import { type SealCaptureInput, type SealedCapture, sealCapture } from "../src/seal";
import { loadSigner } from "../src/signer";
import { newCaptureId, sealInputFor } from "./support/capture-input";
import { previewEnv } from "./support/evidence-env";
import { localSigner } from "./support/local-signer";
import { publishedLogTiles } from "./support/log-tiles";

vi.mock("../src/signer", () => ({ loadSigner: vi.fn() }));
vi.mock("@reranker/jobs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@reranker/jobs")>()),
  enqueue: vi.fn(async () => ({ jobId: "evidence.integrate:test", created: true })),
}));

// The log is one index space, so this suite integrates and publishes the whole preview log, as
// the tiles suite does, and asserts only on its own captures.
const ORIGIN = previewEnv.EVIDENCE_LOG_ORIGIN;
const LOG_BUCKET = previewEnv.R2_LOG_BUCKET;
const BUILDS = 50;
const signers = {
  capture: localSigner("rr-capture-preview-1-ed25519"),
  log: localSigner("rr-log-preview-1"),
};

// Both buckets behind the S3 API, holding objects as fetch hands them back: ungzipped.
const r2 = new Map<string, Uint8Array<ArrayBuffer>>();
async function memoryR2(request: Request): Promise<Response> {
  const key = decodeURIComponent(new URL(request.url).pathname).slice(1);
  if (request.method === "PUT") {
    if (request.headers.get("if-none-match") === "*" && r2.has(key)) {
      return new Response(null, { status: 412 });
    }
    const body = new Uint8Array(await request.arrayBuffer());
    r2.set(key, request.headers.get("content-encoding") === "gzip" ? gunzipSync(body) : body);
    return new Response(null, { status: 200 });
  }
  const body = r2.get(key);
  return body ? new Response(body) : new Response(null, { status: 404 });
}

const query = <T extends Record<string, unknown>>(q: SQL) =>
  withSystem("evidence.test", async (tx) => (await tx.execute<T>(q)).rows);

beforeAll(async () => {
  for (const [name, value] of Object.entries(previewEnv)) vi.stubEnv(name, value);
  vi.stubEnv("VERCEL_REGION", "iad1");
  vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "fedcba9876543210fedcba9876543210fedcba98");
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) =>
    memoryR2(new Request(input, init)),
  );
  resetEvidenceEnv();
  vi.mocked(loadSigner).mockImplementation(async (purpose) => signers[purpose]);
  for (const [key, body] of await publishedLogTiles(ORIGIN)) {
    r2.set(`${LOG_BUCKET}/${key}`, new Uint8Array(body));
  }
  // Whatever earlier suites left pending goes first, so each test's batch holds only its own.
  while ((await integrate(ORIGIN)).status === "integrated");
  await publishPendingBatches(ORIGIN);
}, 120_000);

afterAll(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  resetEvidenceEnv();
  await endPools();
});

/** Seals captures and writes their rows in one transaction, as the capture step does. */
async function sealAndPersist(inputs: SealCaptureInput[]): Promise<SealedCapture[]> {
  return withSystem("evidence.test", async (tx) => {
    const {
      rows: [plan],
    } = await tx.execute<{ id: string }>(sql`
      insert into public_panel.measurement_plans (purpose, ref_type, ref_id, digest, slot_count)
      values ('contract-test', 'probe', ${randomUUID()}, ${randomBytes(32)}, ${inputs.length})
      returning id`);
    if (!plan) throw new Error("No measurement plan was inserted");
    const seals: SealedCapture[] = [];
    for (const input of inputs) seals.push(await sealCapture(input, { tx }));
    await tx.execute(sql`
      insert into public_panel.captures (id, measurement_id, slot_index, attempt, intent_set_id,
        intent_id, engine, channel, provider, mode, status, response_bytes, latency_ms,
        cost_amount_micros, cost_currency, envelope_sha256, normalized_sha256, parser_version)
      select v.id, ${plan.id}, v.slot - 1, 1, 'is_0123456789abcdef',
        'odontologia.blanqueamiento-dental', 'chatgpt', 'ui-vendor', 'dataforseo', 'live',
        'succeeded', 2048, 900, 4000, 'USD', decode(v.envelope, 'hex'), decode(v.normalized, 'hex'),
        case when v.normalized is null then null else 1 end
      from unnest(${sql.param(seals.map((s) => s.captureId))}::text[],
                  ${sql.param(seals.map((s) => s.envelopeSha256))}::text[],
                  ${sql.param(seals.map((s) => s.normalizedSha256))}::text[])
        with ordinality as v(id, envelope, normalized, slot)`);
    return seals;
  });
}

const seal = async (n = 1) =>
  sealAndPersist(Array.from({ length: n }, () => sealInputFor(newCaptureId())));

/** n statements waiting for the log, so the captures land deep inside multi-tile trees. */
async function seedEntries(n: number): Promise<void> {
  const refs = Array.from({ length: n }, () => randomUUID());
  const digests = Array.from({ length: n }, () => randomBytes(32).toString("hex"));
  await query(sql`
    insert into public_panel.evidence_entries (ref, kind, envelope_sha256)
    select v.ref, 'consent', decode(v.envelope, 'hex')
    from unnest(${sql.param(refs)}::text[], ${sql.param(digests)}::text[]) as v(ref, envelope)`);
}

/** Appends everything pending as one batch and publishes it; returns its tree size. */
async function integrateBatch(): Promise<number> {
  const result = await integrate(ORIGIN);
  if (result.status !== "integrated") throw new Error(`integrate returned ${result.status}`);
  await publishPendingBatches(ORIGIN);
  return result.treeSize;
}

async function logIndexOf(captureId: CaptureId): Promise<number> {
  const [row] = await query<{ log_index: string }>(
    sql`select log_index from public_panel.captures where id = ${captureId}`,
  );
  return Number(row?.log_index);
}

async function anchor(
  treeSize: number,
  rows: Array<{ kind: "ots" | "rfc3161"; provider: string; status: string; at?: Date }>,
): Promise<void> {
  for (const row of rows) {
    const confirmed = row.kind === "ots" && row.status === "confirmed";
    await query(sql`
      insert into public_panel.timestamp_anchors
        (origin, tree_size, kind, provider, status, proof, bitcoin_height, attested_at)
      values (${ORIGIN}, ${treeSize}, ${row.kind}, ${row.provider}, ${row.status},
        ${randomBytes(48)}, ${confirmed ? 900_000 + treeSize : null}, ${row.at ?? null})
      on conflict (origin, tree_size, kind, provider) do update
        set status = excluded.status, bitcoin_height = excluded.bitcoin_height,
          attested_at = excluded.attested_at`);
  }
}

const bytes = (base64: string) => new Uint8Array(Buffer.from(base64, "base64"));
const isOdd = (n: number) => n % 2 === 1;

// RFC 9162 §2.1.3.2: the root an inclusion proof leads to.
function rootFromInclusion(bundle: EvidenceBundleV1): Uint8Array {
  const { index, tree_size, hashes } = bundle.inclusion;
  const entry = createHash("sha256").update(envelopeBytes(bundle.envelope)).digest();
  let fn = index;
  let sn = tree_size - 1;
  let r = leafHash(new Uint8Array(entry));
  for (const p of hashes.map(bytes)) {
    if (sn === 0) throw new Error("inclusion proof is too long");
    if (isOdd(fn) || fn === sn) {
      r = nodeHash(p, r);
      while (!isOdd(fn) && fn !== 0) {
        fn /= 2;
        sn = Math.floor(sn / 2);
      }
    } else {
      r = nodeHash(r, p);
    }
    fn = Math.floor(fn / 2);
    sn = Math.floor(sn / 2);
  }
  if (sn !== 0) throw new Error("inclusion proof is too short");
  return r;
}

// RFC 9162 §2.1.4.2: whether the latest checkpoint extends the bundle's.
function consistent(bundle: EvidenceBundleV1): boolean {
  const first = parseCheckpoint(bundle.checkpoint);
  const second = parseCheckpoint(bundle.latest.checkpoint);
  const proof = bundle.latest.consistency.map(bytes);
  if (first.size === second.size) {
    return proof.length === 0 && Buffer.compare(first.root, second.root) === 0;
  }
  const path = Number.isInteger(Math.log2(first.size)) ? [first.root, ...proof] : proof;
  let fn = first.size - 1;
  let sn = second.size - 1;
  while (isOdd(fn)) {
    fn = Math.floor(fn / 2);
    sn = Math.floor(sn / 2);
  }
  let fr = path[0] as Uint8Array;
  let sr = fr;
  for (const c of path.slice(1)) {
    if (sn === 0) return false;
    if (isOdd(fn) || fn === sn) {
      fr = nodeHash(c, fr);
      sr = nodeHash(c, sr);
      while (!isOdd(fn) && fn !== 0) {
        fn /= 2;
        sn = Math.floor(sn / 2);
      }
    } else {
      sr = nodeHash(sr, c);
    }
    fn = Math.floor(fn / 2);
    sn = Math.floor(sn / 2);
  }
  return sn === 0 && Buffer.compare(fr, first.root) === 0 && Buffer.compare(sr, second.root) === 0;
}

test("the bundle of a logged capture verifies end to end with the format package", async () => {
  await seedEntries(300);
  const [capture] = await seal();
  if (!capture) throw new Error("No capture was sealed");
  await seedEntries(250);
  const first = await integrateBatch();
  await seedEntries(40);
  const latest = await integrateBatch();

  const bundle = await buildBundle(capture.captureId);
  if (!bundle) throw new Error("A published capture has no bundle");
  expect(EvidenceBundleV1Schema.safeParse(bundle).success).toBe(true);
  expect(bundle.inclusion).toMatchObject({
    log: ORIGIN,
    index: await logIndexOf(capture.captureId),
    tree_size: first,
  });
  expect(createHash("sha256").update(envelopeBytes(bundle.envelope)).digest("hex")).toBe(
    capture.envelopeSha256,
  );
  expect(rootFromInclusion(bundle)).toEqual(parseCheckpoint(bundle.checkpoint).root);
  expect(parseCheckpoint(bundle.latest.checkpoint).size).toBe(latest);
  expect(consistent(bundle)).toBe(true);
  expect(bundle.artifacts).toEqual({
    raw: { sha256: capture.rawSha256, status: "available" },
    normalized: { sha256: capture.normalizedSha256, status: "available" },
  });
  expect(bundle.anchors).toEqual({ ots: null, tsr: [] });
});

test("a signed but not yet logged capture: summary status signed, no bundle", async () => {
  const [capture] = await seal();
  if (!capture) throw new Error("No capture was sealed");
  expect(await buildBundle(capture.captureId)).toBeNull();
  expect(await getSealSummaries([capture.captureId])).toEqual([
    {
      captureId: capture.captureId,
      savedAt: expect.any(Date),
      status: "signed",
      datedBefore: null,
      verifyUrl: `https://reranker.co/verificar/${capture.captureId}`,
    },
  ]);
  expect(await buildBundle(newCaptureId())).toBeNull();
});

test("getSealSummaries keeps input order, drops unknown ids and runs one query", async () => {
  const [c1, c2] = await seal(2);
  if (!c1 || !c2) throw new Error("No captures were sealed");
  await integrateBatch();

  // Calls through, recording every statement the pooled clients send.
  const spy = vi.spyOn(pg.Client.prototype, "query");
  const out = await getSealSummaries([c2.captureId, newCaptureId(), c1.captureId]);
  const queries = spy.mock.calls
    .map(([config]: unknown[]) =>
      typeof config === "string" ? config : (config as { text?: string }).text,
    )
    .filter((text) => text?.includes("public_panel."));
  spy.mockRestore();
  expect(out.map((s) => s.captureId)).toEqual([c2.captureId, c1.captureId]);
  expect(out.map((s) => s.status)).toEqual(["logged", "logged"]);
  expect(out[0]?.verifyUrl).toBe(verifyUrl(c2.captureId));
  expect(queries).toHaveLength(1);
});

test("datedBefore is the earliest confirmed OTS of any batch that contains the entry", async () => {
  const [capture] = await seal();
  if (!capture) throw new Error("No capture was sealed");
  const id = capture.captureId;
  await seedEntries(3);
  await integrateBatch();
  await seedEntries(3);
  const second = await integrateBatch();
  await seedEntries(3);
  const third = await integrateBatch();

  // The hour's checkpoint is the third; Bitcoin confirms it before the second one's.
  const thirdAt = new Date("2026-11-19T10:00:00Z");
  await anchor(second, [
    { kind: "ots", provider: "ots-calendars", status: "pending" },
    { kind: "rfc3161", provider: "digicert", status: "confirmed" },
  ]);
  await anchor(third, [
    { kind: "ots", provider: "ots-calendars", status: "confirmed", at: thirdAt },
  ]);
  const [dated] = await getSealSummaries([id]);
  expect(dated).toMatchObject({ status: "dated", datedBefore: thirdAt });
  const confirmedLater = await buildBundle(id);
  expect(confirmedLater?.inclusion.tree_size).toBe(third);
  expect(confirmedLater?.anchors.ots).toMatchObject({
    status: "confirmed",
    bitcoin_height: 900_000 + third,
  });
  expect(confirmedLater?.anchors.tsr).toEqual([]);

  const secondAt = new Date("2026-11-19T11:00:00Z");
  await anchor(second, [
    { kind: "ots", provider: "ots-calendars", status: "confirmed", at: secondAt },
  ]);
  const [redated] = await getSealSummaries([id]);
  expect(redated?.datedBefore).toEqual(secondAt);
  const bundle = await buildBundle(id);
  if (!bundle) throw new Error("A dated capture has no bundle");
  expect(EvidenceBundleV1Schema.safeParse(bundle).success).toBe(true);
  expect(bundle.inclusion.tree_size).toBe(second);
  expect(parseCheckpoint(bundle.checkpoint).size).toBe(second);
  expect(rootFromInclusion(bundle)).toEqual(parseCheckpoint(bundle.checkpoint).root);
  expect(consistent(bundle)).toBe(true);
  expect(bundle.anchors.ots?.status).toBe("confirmed");
  expect(bundle.anchors.tsr).toEqual([{ provider: "digicert", proof: expect.any(String) }]);
});

test("a removed artifact is marked removed and a capture without a parse has no normalized", async () => {
  const [unparsed] = await sealAndPersist([{ ...sealInputFor(newCaptureId()), normalized: null }]);
  if (!unparsed) throw new Error("No capture was sealed");
  await integrateBatch();
  await query(sql`
    insert into public_panel.artifact_removals (sha256, kind, reason)
    values (decode(${unparsed.rawSha256}, 'hex'), 'raw', 'personal_data_request')`);

  const bundle = await buildBundle(unparsed.captureId);
  if (!bundle) throw new Error("A published capture has no bundle");
  expect(EvidenceBundleV1Schema.safeParse(bundle).success).toBe(true);
  expect("normalized" in bundle.artifacts).toBe(false);
  expect(bundle.artifacts.raw).toEqual({
    sha256: unparsed.rawSha256,
    status: "removed",
    removed_at: expect.stringMatching(/Z$/),
    reason: "personal_data_request",
  });
  expect(rootFromInclusion(bundle)).toEqual(parseCheckpoint(bundle.checkpoint).root);
});

test(`buildBundle p95 under 250 ms against Neon over ${BUILDS} builds`, async () => {
  await seedEntries(500);
  const [capture] = await seal();
  if (!capture) throw new Error("No capture was sealed");
  await seedEntries(300);
  await integrateBatch();
  await buildBundle(capture.captureId);

  const times: number[] = [];
  for (let i = 0; i < BUILDS; i++) {
    const start = performance.now();
    await buildBundle(capture.captureId);
    times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  const p95 = times[Math.ceil(0.95 * BUILDS) - 1] ?? Number.NaN;
  console.info(`buildBundle p50 ${times[BUILDS / 2]?.toFixed(1)} ms, p95 ${p95.toFixed(1)} ms`);
  expect(p95).toBeLessThan(250);
});
