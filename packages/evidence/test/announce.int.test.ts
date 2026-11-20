import { createHash, randomUUID } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { endPools, withSystem } from "@reranker/db";
import { verifyKeyAnnouncement } from "@reranker/verify";
import type { DsseEnvelope } from "@reranker/verify/format";
import type { TrustedKey } from "@reranker/verify/trust";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, expect, test, vi } from "vitest";
import { announceKeys } from "../src/announce";
import { resetEvidenceEnv } from "../src/env";
import { SigningKeyMismatchError } from "../src/errors";
import { loadSigner, type Signer } from "../src/signer";
import { previewEnv } from "./support/evidence-env";
import { localSigner } from "./support/local-signer";

vi.mock("../src/signer", () => ({ loadSigner: vi.fn() }));
vi.mock("@reranker/jobs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@reranker/jobs")>()),
  enqueue: vi.fn(async () => ({ jobId: "evidence.integrate:test", created: true })),
}));
const registry = vi.hoisted(() => ({
  production: [] as TrustedKey[],
  preview: [] as TrustedKey[],
}));
vi.mock("@reranker/verify/trust", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@reranker/verify/trust")>()),
  KEYS_BY_ENV: registry,
}));

const COMMIT = "fedcba9876543210fedcba9876543210fedcba98";

// R2 behind the S3 API, holding objects ungzipped.
const r2 = new Map<string, Uint8Array<ArrayBuffer>>();
async function fakeR2(request: Request): Promise<Response> {
  const key = new URL(request.url).pathname.split("/").slice(2).join("/");
  if (request.method === "PUT") {
    r2.set(key, new Uint8Array(gunzipSync(new Uint8Array(await request.arrayBuffer()))));
    return new Response(null, { status: 200 });
  }
  const body = r2.get(key);
  return body ? new Response(body, { status: 200 }) : new Response(null, { status: 404 });
}

// Log entries are append-only, so every test announces keys no other run has used.
function pinned(signer: Signer, purpose: TrustedKey["purpose"], validFrom: string): TrustedKey {
  return {
    keyid: signer.keyid,
    purpose,
    env: "preview",
    alg: "Ed25519",
    publicKey: Buffer.from(signer.publicKey).toString("base64"),
    custody: "aws-kms-hsm",
    validFrom,
    validTo: null,
    compromisedAfter: null,
  };
}

function keySet() {
  const run = randomUUID().slice(0, 8);
  const capture = localSigner(`rr-capture-test-${run}-ed25519`);
  const log = localSigner(`rr-log-test-${run}`);
  vi.mocked(loadSigner).mockImplementation(async (purpose) =>
    purpose === "capture" ? capture : log,
  );
  return { capture, log };
}

async function loggedEnvelope(keyid: string): Promise<DsseEnvelope> {
  const { rows } = await withSystem("evidence.test", (tx) =>
    tx.execute<{ envelope_sha256: Buffer }>(
      sql`select envelope_sha256 from public_panel.evidence_entries
          where kind = 'key' and ref = ${keyid}`,
    ),
  );
  expect(rows).toHaveLength(1);
  const sha256 = rows[0]?.envelope_sha256.toString("hex") ?? "";
  const bytes = r2.get(`envelopes/${sha256}`);
  if (!bytes) throw new Error(`no stored envelope for ${keyid}`);
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(sha256);
  return JSON.parse(new TextDecoder().decode(bytes));
}

afterAll(() => endPools());

beforeEach(() => {
  for (const [name, value] of Object.entries(previewEnv)) vi.stubEnv(name, value);
  vi.stubEnv("VERCEL_REGION", "iad1");
  vi.stubEnv("VERCEL_GIT_COMMIT_SHA", COMMIT);
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => fakeR2(new Request(input, init))),
  );
  r2.clear();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  resetEvidenceEnv();
});

test("each current key is announced once, in a statement the browser verifier accepts", async () => {
  const { capture, log } = keySet();
  registry.preview = [
    pinned(capture, "capture", "2026-11-20T18:29:31.957Z"),
    pinned(log, "log", "2026-11-20T18:29:32.321Z"),
  ];

  expect(await announceKeys()).toEqual({ announced: [capture.keyid, log.keyid] });

  const captureEnvelope = await loggedEnvelope(capture.keyid);
  expect(captureEnvelope.signatures.map((s) => s.keyid)).toEqual([capture.keyid, log.keyid]);
  const verified = verifyKeyAnnouncement(captureEnvelope, registry.preview);
  expect(verified.check).toEqual({ status: "pass" });
  expect(verified.statement?.predicate).toMatchObject({
    key: { keyid: capture.keyid, purpose: "capture", env: "preview" },
    previous: null,
    worker: { id: "vercel:iad1", image_digest: `git:${COMMIT}` },
  });

  const logEnvelope = await loggedEnvelope(log.keyid);
  expect(logEnvelope.signatures.map((s) => s.keyid)).toEqual([log.keyid]);
  expect(verifyKeyAnnouncement(logEnvelope, registry.preview).check).toEqual({ status: "pass" });

  vi.mocked(loadSigner).mockClear();
  expect(await announceKeys()).toEqual({ announced: [] });
  expect(loadSigner).not.toHaveBeenCalled();
});

test("a successor whose predecessor cannot sign here is not announced", async () => {
  const { capture, log } = keySet();
  const retired = localSigner(`rr-capture-retired-${randomUUID().slice(0, 8)}-ed25519`);
  registry.preview = [
    {
      ...pinned(retired, "capture", "2026-11-01T00:00:00.000Z"),
      validTo: "2026-11-20T18:29:31.957Z",
    },
    pinned(capture, "capture", "2026-11-20T18:29:31.957Z"),
    pinned(log, "log", "2026-11-20T18:29:32.321Z"),
  ];

  await expect(announceKeys()).rejects.toThrow(SigningKeyMismatchError);
  const { rows } = await withSystem("evidence.test", (tx) =>
    tx.execute(
      sql`select 1 from public_panel.evidence_entries where kind = 'key' and ref = ${capture.keyid}`,
    ),
  );
  expect(rows).toEqual([]);
});
