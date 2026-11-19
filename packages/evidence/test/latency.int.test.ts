import { gunzipSync } from "node:zlib";
import { endPools, withSystem } from "@reranker/db";
import { enqueue } from "@reranker/jobs";
import { InvalidInputError } from "@reranker/jobs/errors";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, expect, test, vi } from "vitest";
import { resetEvidenceEnv } from "../src/env";
import { EvidenceStorageUnavailableError } from "../src/errors";
import { probeSealCapture } from "../src/latency";
import { loadSigner, signingProvisioned } from "../src/signer";
import { previewEnv } from "./support/evidence-env";
import { localSigner } from "./support/local-signer";

vi.mock("../src/signer", () => ({ loadSigner: vi.fn(), signingProvisioned: vi.fn() }));
vi.mock("@reranker/jobs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@reranker/jobs")>()),
  enqueue: vi.fn(async () => ({ jobId: "evidence.integrate:test", created: true })),
}));

// R2 as aws4fetch sees it, counting every object ever written so a test can tell what was left.
const r2 = new Map<string, Uint8Array>();
let puts = 0;
let failDeletes = false;
let failPutAfter = Number.POSITIVE_INFINITY;
const objectKey = (url: string) => new URL(url).pathname.split("/").slice(2).join("/");

async function fakeR2(request: Request): Promise<Response> {
  const key = objectKey(request.url);
  if (request.method === "PUT") {
    if (puts++ >= failPutAfter) return new Response(null, { status: 503 });
    if (r2.has(key)) return new Response(null, { status: 412 });
    r2.set(key, gunzipSync(new Uint8Array(await request.arrayBuffer())));
    return new Response(null, { status: 200 });
  }
  if (request.method === "DELETE") {
    if (failDeletes) return new Response(null, { status: 503 });
    r2.delete(key);
    return new Response(null, { status: 204 });
  }
  const body = r2.get(key);
  return body ? new Response(new Uint8Array(body)) : new Response(null, { status: 404 });
}

const captureRows = async () => {
  const { rows } = await withSystem("evidence.test", (tx) =>
    tx.execute<{ n: number }>(sql`select count(*)::int as n from public_panel.captures`),
  );
  return rows[0]?.n;
};

afterAll(() => endPools());

beforeEach(() => {
  for (const [name, value] of Object.entries(previewEnv)) vi.stubEnv(name, value);
  vi.stubEnv("VERCEL_REGION", "iad1");
  vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "fedcba9876543210fedcba9876543210fedcba98");
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => fakeR2(new Request(input, init))),
  );
  vi.mocked(signingProvisioned).mockReturnValue(false);
  vi.mocked(loadSigner).mockResolvedValue(localSigner("rr-capture-preview-1-ed25519"));
  vi.mocked(enqueue).mockClear();
  r2.clear();
  puts = 0;
  failDeletes = false;
  failPutAfter = Number.POSITIVE_INFINITY;
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  resetEvidenceEnv();
});

test("without a capture key, times every part but the signature and leaves nothing behind", async () => {
  const before = await captureRows();
  const report = await probeSealCapture(3);

  expect(report.sealCapture).toBeNull();
  expect(report.sign).toBeNull();
  for (const part of [report.r2WriteRound, report.database, report.hold, report.envelope]) {
    expect(part).toEqual({ p50: expect.any(Number), p95: expect.any(Number), n: 3 });
  }
  expect(loadSigner).not.toHaveBeenCalled();
  // A warm-up pass and three timed ones, four objects each.
  expect(puts).toBe(16);
  expect(r2.size).toBe(0);
  expect(await captureRows()).toBe(before);
  expect(enqueue).toHaveBeenCalledWith(
    expect.objectContaining({ name: "evidence.integrate" }),
    { origin: previewEnv.EVIDENCE_LOG_ORIGIN },
    expect.anything(),
  );
});

test("with a capture key, times whole seals and the signature, and deletes what they stored", async () => {
  vi.mocked(signingProvisioned).mockReturnValue(true);
  const before = await captureRows();
  const report = await probeSealCapture(2);

  expect(report.sealCapture).toEqual({ p50: expect.any(Number), p95: expect.any(Number), n: 2 });
  expect(report.sign).toEqual({ p50: expect.any(Number), p95: expect.any(Number), n: 2 });
  expect(report.r2WriteRound.n).toBe(2);
  // Each pass seals one capture (four objects) and writes one round (four more).
  expect(puts).toBe(24);
  expect(r2.size).toBe(0);
  expect(await captureRows()).toBe(before);
});

test("a failed write still deletes everything the pass stored, then fails", async () => {
  failPutAfter = 2;
  await expect(probeSealCapture(1)).rejects.toBeInstanceOf(EvidenceStorageUnavailableError);
  expect(r2.size).toBe(0);
});

test("fails rather than report numbers when its objects cannot be deleted", async () => {
  failDeletes = true;
  await expect(probeSealCapture(1)).rejects.toThrow(/probe objects were not deleted/);
});

test.each([0, 201, 1.5])("refuses %s seals before writing anything", async (n) => {
  await expect(probeSealCapture(n)).rejects.toBeInstanceOf(InvalidInputError);
  expect(puts).toBe(0);
});
