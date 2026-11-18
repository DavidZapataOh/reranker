import { createHash, createPublicKey, randomBytes, randomUUID, verify } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { endPools, type SystemTx, withSystem } from "@reranker/db";
import { enqueue } from "@reranker/jobs";
import { NotFoundError } from "@reranker/jobs/errors";
import { type CaptureId, DSSE_PAYLOAD_TYPE, type DsseEnvelope, pae } from "@reranker/verify/format";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { resetEvidenceEnv } from "../src/env";
import {
  EvidenceStorageUnavailableError,
  SigningKeyMismatchError,
  SigningUnavailableError,
  StatementTooLargeError,
} from "../src/errors";
import { readRaw, type SealCaptureInput, sealCapture } from "../src/seal";
import { loadSigner } from "../src/signer";
import { predicateInput } from "./support/capture-input";
import { previewEnv } from "./support/evidence-env";
import { localSigner } from "./support/local-signer";

vi.mock("../src/signer", () => ({ loadSigner: vi.fn() }));
vi.mock("@reranker/jobs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@reranker/jobs")>()),
  enqueue: vi.fn(async () => ({ jobId: "evidence.integrate:test", created: true })),
}));

const signer = localSigner("rr-capture-preview-1-ed25519");
const COMMIT = "fedcba9876543210fedcba9876543210fedcba98";

// R2 as aws4fetch sees it: objects keyed by path, written once, served already gunzipped as
// fetch would serve them.
const r2 = new Map<string, Uint8Array>();
let r2Down = false;
const objectKey = (url: string) => new URL(url).pathname.split("/").slice(2).join("/");

async function fakeR2(request: Request): Promise<Response> {
  if (r2Down) return new Response(null, { status: 503 });
  const key = objectKey(request.url);
  if (request.method === "PUT") {
    if (r2.has(key) && request.headers.get("if-none-match") === "*") {
      return new Response(null, { status: 412 });
    }
    r2.set(key, new Uint8Array(gunzipSync(new Uint8Array(await request.arrayBuffer()))));
    return new Response(null, { status: 200 });
  }
  const body = r2.get(key);
  return body ? new Response(body, { status: 200 }) : new Response(null, { status: 404 });
}

const utf8 = (s: string) => new TextEncoder().encode(s);
const sha256Of = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const newCaptureId = () => `cap_${randomBytes(13).toString("hex").toUpperCase()}` as CaptureId;

function captureInput(overrides: Partial<SealCaptureInput> = {}): SealCaptureInput {
  const captureId = overrides.captureId ?? newCaptureId();
  return {
    captureId,
    responseBytes: utf8(
      `{"tasks":[{"id":"${captureId}","result":[{"markdown":"Clínica Sonrisa"}]}]}`,
    ),
    responseContentType: "application/json",
    requestBytes: utf8(`[{"user_prompt":"blanqueamiento dental","id":"${captureId}"}]`),
    normalized: {
      json: utf8(`{"answer":"Clínica Sonrisa","id":"${captureId}"}`),
      parserVersion: 1,
    },
    predicate: predicateInput,
    ...overrides,
  };
}

function envelopeAt(envelopeSha256: string): DsseEnvelope {
  const bytes = r2.get(`envelopes/${envelopeSha256}`);
  if (!bytes) throw new Error(`no envelope ${envelopeSha256}`);
  return JSON.parse(new TextDecoder().decode(bytes));
}

const statementOf = (envelope: DsseEnvelope) =>
  JSON.parse(Buffer.from(envelope.payload, "base64").toString("utf8"));

/** What persistCapture does with a seal: the capture row, in the same transaction. */
async function insertCaptureRow(
  tx: SystemTx,
  captureId: CaptureId,
  seal: { envelopeSha256: string; normalizedSha256: string | null },
): Promise<void> {
  const { rows } = await tx.execute<{ id: string }>(
    sql`insert into public_panel.measurement_plans (purpose, ref_type, ref_id, digest, slot_count)
        values ('contract-test', 'probe', ${randomUUID()}, ${Buffer.from(sha256Of(utf8(captureId)), "hex")}, 1)
        returning id`,
  );
  const normalized = seal.normalizedSha256 ? Buffer.from(seal.normalizedSha256, "hex") : null;
  await tx.execute(
    sql`insert into public_panel.captures (id, measurement_id, slot_index, attempt, intent_set_id,
          intent_id, engine, channel, provider, mode, status, response_bytes, latency_ms,
          cost_amount_micros, cost_currency, envelope_sha256, normalized_sha256, parser_version)
        values (${captureId}, ${rows[0]?.id}, 0, 1, 'is_0123456789abcdef',
          'odontologia.blanqueamiento-dental', 'chatgpt', 'ui-vendor', 'dataforseo', 'live',
          'succeeded', 1024, 900, 4000, 'USD', ${Buffer.from(seal.envelopeSha256, "hex")},
          ${normalized}, ${normalized ? 1 : null})`,
  );
}

async function sealAndPersist(input: SealCaptureInput) {
  return withSystem("evidence.test", async (tx) => {
    const sealed = await sealCapture(input, { tx });
    await insertCaptureRow(tx, input.captureId, sealed);
    return sealed;
  });
}

async function scalar(query: ReturnType<typeof sql>): Promise<number> {
  const { rows } = await withSystem("evidence.test", (tx) => tx.execute<{ n: number }>(query));
  return Number(rows[0]?.n);
}

const entriesFor = (ref: string) =>
  scalar(sql`select count(*) as n from public_panel.evidence_entries where ref = ${ref}`);
const capturesWith = (id: string) =>
  scalar(sql`select count(*) as n from public_panel.captures where id = ${id}`);
const storedEnvelopes = () => [...r2.keys()].filter((k) => k.startsWith("envelopes/"));

beforeAll(() => {
  // Concurrency is real only with more connections than the default three of the system pool.
  process.env.DB_POOL_MAX = "12";
});
afterAll(() => endPools());

beforeEach(() => {
  for (const [name, value] of Object.entries(previewEnv)) vi.stubEnv(name, value);
  vi.stubEnv("VERCEL_REGION", "iad1");
  vi.stubEnv("VERCEL_GIT_COMMIT_SHA", COMMIT);
  vi.stubGlobal("fetch", vi.fn(fakeR2));
  vi.mocked(loadSigner).mockResolvedValue(signer);
  vi.mocked(enqueue).mockClear();
  r2.clear();
  r2Down = false;
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  resetEvidenceEnv();
});

describe("sealCapture", () => {
  test("stores raw, request, normalized and envelope, and the statement digests match the bytes", async () => {
    const input = captureInput();
    const sealed = await withSystem("evidence.test", (tx) => sealCapture(input, { tx }));
    const envelope = envelopeAt(sealed.envelopeSha256);
    const stmt = statementOf(envelope);
    expect(stmt.subject).toEqual([
      { name: "raw", digest: { sha256: sha256Of(input.responseBytes) } },
      { name: "request", digest: { sha256: sha256Of(input.requestBytes) } },
      { name: "normalized", digest: { sha256: sha256Of(input.normalized?.json ?? utf8("")) } },
    ]);
    expect(stmt.predicate.capture_id).toBe(input.captureId);
    expect(stmt.predicate.time).toEqual({
      worker_utc: sealed.signedAt.toISOString(),
      roughtime: null,
      not_before: null,
    });
    expect(stmt.predicate.worker).toEqual({ id: "vercel:iad1", image_digest: `git:${COMMIT}` });
    expect(sealed).toMatchObject({
      rawSha256: sha256Of(input.responseBytes),
      requestSha256: sha256Of(input.requestBytes),
      normalizedSha256: sha256Of(input.normalized?.json ?? utf8("")),
      keyid: signer.keyid,
    });
    expect(r2.get(`raw/${sealed.rawSha256}`)).toEqual(input.responseBytes);
    expect(r2.get(`request/${sealed.requestSha256}`)).toEqual(input.requestBytes);
    expect(r2.get(`normalized/${sealed.normalizedSha256}`)).toEqual(input.normalized?.json);
    expect(sha256Of(r2.get(`envelopes/${sealed.envelopeSha256}`) ?? utf8(""))).toBe(
      sealed.envelopeSha256,
    );
    const [signature] = envelope.signatures;
    const publicKey = createPublicKey({
      key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), signer.publicKey]),
      format: "der",
      type: "spki",
    });
    const message = pae(DSSE_PAYLOAD_TYPE, Buffer.from(envelope.payload, "base64"));
    expect(verify(null, message, publicKey, Buffer.from(signature?.sig ?? "", "base64"))).toBe(
      true,
    );
  });

  test("an answer that did not parse is sealed without a normalized subject", async () => {
    const input = captureInput({ normalized: null });
    const sealed = await withSystem("evidence.test", (tx) => sealCapture(input, { tx }));
    expect(sealed.normalizedSha256).toBeNull();
    const names = statementOf(envelopeAt(sealed.envelopeSha256)).subject.map(
      (s: { name: string }) => s.name,
    );
    expect(names).toEqual(["raw", "request"]);
  });

  test("inserts no row; a capture row already present in tx returns its envelope", async () => {
    const input = captureInput();
    const first = await sealAndPersist(input);
    vi.mocked(enqueue).mockClear();
    const retry = await withSystem("evidence.test", (tx) => sealCapture(input, { tx }));
    expect(retry).toEqual(first);
    expect(storedEnvelopes()).toEqual([`envelopes/${first.envelopeSha256}`]);
    expect(await entriesFor(input.captureId)).toBe(0);
    expect(enqueue).not.toHaveBeenCalled();
  });

  test("a rolled back capture transaction leaves no row and nothing pending in the log", async () => {
    const input = captureInput();
    await expect(
      withSystem("evidence.test", async (tx) => {
        await sealCapture(input, { tx });
        throw new Error("capture insert failed");
      }),
    ).rejects.toThrow("capture insert failed");
    expect(await capturesWith(input.captureId)).toBe(0);
    expect(await entriesFor(input.captureId)).toBe(0);
  });

  test("enqueues one integrate per minute, a minute later", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-18T15:04:05.000Z"));
    await Promise.all(
      Array.from({ length: 5 }, () =>
        withSystem("evidence.test", (tx) => sealCapture(captureInput(), { tx })),
      ),
    );
    const calls = vi.mocked(enqueue).mock.calls;
    expect(calls).toHaveLength(5);
    const minute = Math.floor(Date.parse("2026-11-18T15:04:00.000Z") / 60_000);
    for (const [job, payload, opts] of calls) {
      expect(job.name).toBe("evidence.integrate");
      expect(payload).toEqual({ origin: previewEnv.EVIDENCE_LOG_ORIGIN });
      expect(opts).toEqual({
        dedupeKey: `int-${minute}`,
        runAt: new Date("2026-11-18T15:05:00.000Z"),
      });
    }
  });
});

describe("fails closed", () => {
  test.each([
    ["KMS is unavailable", new SigningUnavailableError("KMS is unreachable")],
    ["the key is not the pinned one", new SigningKeyMismatchError("k", "differs from registry")],
  ])("when %s: no envelope and nothing queued", async (_, failure) => {
    vi.mocked(loadSigner).mockRejectedValue(failure);
    await expect(
      withSystem("evidence.test", (tx) => sealCapture(captureInput(), { tx })),
    ).rejects.toBe(failure);
    expect(storedEnvelopes()).toEqual([]);
    expect(enqueue).not.toHaveBeenCalled();
  });

  test("a statement whose PAE is over 4096 bytes is never signed", async () => {
    const prompt = { ...predicateInput.prompt, text: "x".repeat(4096) };
    const input = captureInput({ predicate: { ...predicateInput, prompt } });
    await expect(
      withSystem("evidence.test", (tx) => sealCapture(input, { tx })),
    ).rejects.toBeInstanceOf(StatementTooLargeError);
    expect(storedEnvelopes()).toEqual([]);
    expect(enqueue).not.toHaveBeenCalled();
  });

  test("R2 down: EvidenceStorageUnavailableError and nothing queued", async () => {
    r2Down = true;
    await expect(
      withSystem("evidence.test", (tx) => sealCapture(captureInput(), { tx })),
    ).rejects.toBeInstanceOf(EvidenceStorageUnavailableError);
    expect(enqueue).not.toHaveBeenCalled();
  });

  test("a deployment that does not name its commit signs nothing", async () => {
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "");
    await expect(
      withSystem("evidence.test", (tx) => sealCapture(captureInput(), { tx })),
    ).rejects.toThrow("VERCEL_GIT_COMMIT_SHA (missing)");
    expect(r2.size).toBe(0);
  });
});

describe("readRaw", () => {
  test("returns the exact bytes and rejects a tampered object", async () => {
    const input = captureInput();
    const sealed = await sealAndPersist(input);
    expect(await readRaw(input.captureId)).toEqual(input.responseBytes);
    r2.set(`raw/${sealed.rawSha256}`, utf8('{"tasks":[]}'));
    await expect(readRaw(input.captureId)).rejects.toBeInstanceOf(NotFoundError);
    await expect(readRaw(newCaptureId())).rejects.toBeInstanceOf(NotFoundError);
  });
});
