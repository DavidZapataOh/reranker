import { createPublicKey, randomBytes, randomUUID, verify } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { endPools, withSystem } from "@reranker/db";
import { type EvidenceBundleV1, EvidenceBundleV1Schema, pae } from "@reranker/verify/format";
import { type SQL, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { putArtifact } from "../src/artifacts";
import { buildBundle } from "../src/bundle";
import { resetEvidenceEnv } from "../src/env";
import { integrate } from "../src/log/integrate";
import { publishPendingBatches } from "../src/log/tiles";
import { removeArtifact } from "../src/removal";
import { type SealedCapture, sealCapture } from "../src/seal";
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

const ORIGIN = previewEnv.EVIDENCE_LOG_ORIGIN;
const signers = {
  capture: localSigner("rr-capture-preview-1-ed25519"),
  log: localSigner("rr-log-preview-1"),
};
const PURGE_URL = `https://api.cloudflare.com/client/v4/zones/${previewEnv.CLOUDFLARE_ZONE_ID}/purge_cache`;

// R2 behind the S3 API, holding objects ungzipped, and the Cloudflare purge endpoint.
const r2 = new Map<string, Uint8Array<ArrayBuffer>>();
const purges: Array<{ authorization: string | null; body: unknown }> = [];
let purgeStatus = 200;
async function cloudflare(request: Request): Promise<Response> {
  if (request.url.startsWith("https://api.cloudflare.com/")) {
    expect(request.url).toBe(PURGE_URL);
    expect(request.method).toBe("POST");
    purges.push({
      authorization: request.headers.get("authorization"),
      body: await request.json(),
    });
    return Response.json(
      { success: purgeStatus === 200, errors: [], messages: [], result: { id: "zone" } },
      { status: purgeStatus },
    );
  }
  const key = decodeURIComponent(new URL(request.url).pathname).slice(1);
  if (request.method === "PUT") {
    if (request.headers.get("if-none-match") === "*" && r2.has(key)) {
      return new Response(null, { status: 412 });
    }
    const body = new Uint8Array(await request.arrayBuffer());
    r2.set(key, request.headers.get("content-encoding") === "gzip" ? gunzipSync(body) : body);
    return new Response(null, { status: 200 });
  }
  if (request.method === "DELETE") {
    r2.delete(key);
    return new Response(null, { status: 204 });
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
    cloudflare(new Request(input, init)),
  );
  resetEvidenceEnv();
  vi.mocked(loadSigner).mockImplementation(async (purpose) => signers[purpose]);
  for (const [key, body] of await publishedLogTiles(ORIGIN)) {
    r2.set(`${previewEnv.R2_LOG_BUCKET}/${key}`, new Uint8Array(body));
  }
  while ((await integrate(ORIGIN)).status === "integrated");
  await publishPendingBatches(ORIGIN);
}, 120_000);

beforeEach(() => {
  purges.length = 0;
  purgeStatus = 200;
});

afterAll(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  resetEvidenceEnv();
  await endPools();
});

/** Seals n captures, writes their rows as the capture step does, then logs and publishes them. */
async function sealIntegratePublish(n: number): Promise<SealedCapture[]> {
  const seals = await withSystem("evidence.test", async (tx) => {
    const {
      rows: [plan],
    } = await tx.execute<{ id: string }>(sql`
      insert into public_panel.measurement_plans (purpose, ref_type, ref_id, digest, slot_count)
      values ('contract-test', 'probe', ${randomUUID()}, ${randomBytes(32)}, ${n})
      returning id`);
    if (!plan) throw new Error("No measurement plan was inserted");
    const sealed: SealedCapture[] = [];
    for (let i = 0; i < n; i++) sealed.push(await sealCapture(sealInputFor(newCaptureId())));
    await tx.execute(sql`
      insert into public_panel.captures (id, measurement_id, slot_index, attempt, intent_set_id,
        intent_id, engine, channel, provider, mode, status, response_bytes, latency_ms,
        cost_amount_micros, cost_currency, envelope_sha256, normalized_sha256, parser_version)
      select v.id, ${plan.id}, v.slot - 1, 1, 'is_0123456789abcdef',
        'odontologia.blanqueamiento-dental', 'chatgpt', 'ui-vendor', 'dataforseo', 'live',
        'succeeded', 2048, 900, 4000, 'USD', decode(v.envelope, 'hex'), decode(v.normalized, 'hex'), 1
      from unnest(${sql.param(sealed.map((s) => s.captureId))}::text[],
                  ${sql.param(sealed.map((s) => s.envelopeSha256))}::text[],
                  ${sql.param(sealed.map((s) => s.normalizedSha256))}::text[])
        with ordinality as v(id, envelope, normalized, slot)`);
    return sealed;
  });
  const result = await integrate(ORIGIN);
  if (result.status !== "integrated") throw new Error(`integrate returned ${result.status}`);
  await publishPendingBatches(ORIGIN);
  return seals;
}

async function bundleOf(capture: SealedCapture): Promise<EvidenceBundleV1> {
  const bundle = await buildBundle(capture.captureId);
  if (!bundle) throw new Error("A published capture has no bundle");
  return bundle;
}

/** Whether the envelope's signature verifies with the capture key, over the DSSE PAE. */
function signatureVerifies(bundle: EvidenceBundleV1): boolean {
  const [signature] = bundle.envelope.signatures;
  if (!signature) return false;
  const key = createPublicKey({
    key: {
      kty: "OKP",
      crv: "Ed25519",
      x: Buffer.from(signers.capture.publicKey).toString("base64url"),
    },
    format: "jwk",
  });
  const message = pae(bundle.envelope.payloadType, Buffer.from(bundle.envelope.payload, "base64"));
  return verify(null, message, key, Buffer.from(signature.sig, "base64"));
}

const removalsOf = (sha256: string) =>
  query<{ kind: string; reason: string }>(sql`
    select kind, reason from public_panel.artifact_removals where sha256 = decode(${sha256}, 'hex')`);

test("after removal the bundle marks the artifact removed and signature and inclusion still verify", async () => {
  const captures = await sealIntegratePublish(5);
  const capture = captures[2] as SealedCapture;
  const before = await bundleOf(capture);

  await removeArtifact(capture.rawSha256, "raw", "personal_data_request");

  expect(r2.has(`${previewEnv.R2_EVIDENCE_BUCKET}/raw/${capture.rawSha256}`)).toBe(false);
  const after = await bundleOf(capture);
  expect(EvidenceBundleV1Schema.safeParse(after).success).toBe(true);
  expect(after.artifacts.raw).toEqual({
    sha256: capture.rawSha256,
    status: "removed",
    removed_at: expect.stringMatching(/Z$/),
    reason: "personal_data_request",
  });
  expect(after.artifacts.normalized).toEqual(before.artifacts.normalized);
  // Removal touches only the artifact: the signed envelope and every proof stay as they were.
  const { artifacts: _after, ...proofsAfter } = after;
  const { artifacts: _before, ...proofsBefore } = before;
  expect(proofsAfter).toEqual(proofsBefore);
  expect(signatureVerifies(after)).toBe(true);

  const neighbour = await bundleOf(captures[1] as SealedCapture);
  expect(neighbour.artifacts.raw.status).toBe("available");
});

test("removal is idempotent and purges the public URL once", async () => {
  const [capture] = await sealIntegratePublish(1);
  if (!capture) throw new Error("No capture was sealed");
  const sha256 = capture.normalizedSha256 as string;

  expect(await removeArtifact(sha256, "normalized", "legal_order")).toEqual({ created: true });
  expect(await removeArtifact(sha256, "normalized", "legal_order")).toEqual({ created: false });

  expect(purges).toEqual([
    {
      authorization: `Bearer ${previewEnv.CLOUDFLARE_CACHE_PURGE_TOKEN}`,
      body: { files: [`${previewEnv.EVIDENCE_ARTIFACTS_BASE_URL}/normalized/${sha256}`] },
    },
  ]);
  expect(await removalsOf(sha256)).toEqual([{ kind: "normalized", reason: "legal_order" }]);
  expect((await bundleOf(capture)).artifacts.normalized).toMatchObject({ status: "removed" });
});

test("a failed purge records nothing, so the retry removes it again", async () => {
  const [capture] = await sealIntegratePublish(1);
  if (!capture) throw new Error("No capture was sealed");
  purgeStatus = 403;

  await expect(removeArtifact(capture.rawSha256, "raw", "personal_data_request")).rejects.toThrow(
    /purge/,
  );
  expect(await removalsOf(capture.rawSha256)).toEqual([]);
  expect((await bundleOf(capture)).artifacts.raw.status).toBe("available");

  purgeStatus = 200;
  await removeArtifact(capture.rawSha256, "raw", "personal_data_request");
  expect(purges).toHaveLength(2);
  expect(await removalsOf(capture.rawSha256)).toEqual([
    { kind: "raw", reason: "personal_data_request" },
  ]);
});

test("removing an extractions artifact deletes it from the private bucket and calls no purge", async () => {
  const bytes = new TextEncoder().encode(JSON.stringify({ run: randomUUID() }));
  const { sha256 } = await putArtifact("extractions", bytes, { contentType: "application/json" });
  const key = `${previewEnv.R2_INTERNAL_BUCKET}/extractions/${sha256}`;
  expect(r2.has(key)).toBe(true);

  await removeArtifact(sha256, "extractions", "personal_data_request");

  expect(r2.has(key)).toBe(false);
  expect(purges).toEqual([]);
  expect(await removalsOf(sha256)).toEqual([
    { kind: "extractions", reason: "personal_data_request" },
  ]);
});

test("a malformed digest is rejected before anything is recorded", async () => {
  await expect(removeArtifact("ABC", "raw", "personal_data_request")).rejects.toThrow(/SHA-256/);
  expect(purges).toEqual([]);
});
