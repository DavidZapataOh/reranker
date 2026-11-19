import { endPools, withSystem } from "@reranker/db";
import { requireEnv } from "@reranker/testing/env";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { deleteArtifact } from "../src/artifacts";
import { resetEvidenceEnv } from "../src/env";
import { type SealedCapture, sealCapture } from "../src/seal";
import { loadSigner, type Signer } from "../src/signer";
import { newCaptureId, sealInputFor } from "./support/capture-input";
import { previewEnv } from "./support/evidence-env";
import { localSigner } from "./support/local-signer";

vi.mock("../src/signer", () => ({ loadSigner: vi.fn() }));
// One integration is queued per minute however many captures are sealed in it, so its cost is
// not part of a single seal.
vi.mock("@reranker/jobs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@reranker/jobs")>()),
  enqueue: vi.fn(async () => ({ jobId: "evidence.integrate:test", created: true })),
}));

// The preview evidence bucket, written with the bucket-scoped CI key; every object a run creates
// is deleted before it ends.
const SEALS = 100;
// KMS Sign's p95 budget, so the local key costs what the real one may.
const KMS_SIGN_MS = 40;
// A DataForSEO answer with sources runs to tens of kilobytes.
const RESPONSE_BYTES = 24 * 1024;

const local = localSigner("rr-capture-preview-1-ed25519");
const kmsLike: Signer = {
  ...local,
  sign: async (message) => {
    await new Promise((resolve) => setTimeout(resolve, KMS_SIGN_MS));
    return local.sign(message);
  },
};

const sealed: SealedCapture[] = [];

beforeAll(() => {
  for (const [name, value] of Object.entries(previewEnv)) vi.stubEnv(name, value);
  vi.stubEnv("R2_ACCOUNT_ID", requireEnv("CLOUDFLARE_ACCOUNT_ID"));
  vi.stubEnv("R2_ACCESS_KEY_ID", requireEnv("R2_ACCESS_KEY_ID_CI"));
  vi.stubEnv("R2_SECRET_ACCESS_KEY", requireEnv("R2_SECRET_ACCESS_KEY_CI"));
  vi.stubEnv("VERCEL_REGION", "iad1");
  vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "fedcba9876543210fedcba9876543210fedcba98");
  resetEvidenceEnv();
  vi.mocked(loadSigner).mockResolvedValue(kmsLike);
});

afterAll(async () => {
  await Promise.all(
    sealed.flatMap((s) => [
      deleteArtifact("raw", s.rawSha256),
      deleteArtifact("request", s.requestSha256),
      deleteArtifact("envelopes", s.envelopeSha256),
      ...(s.normalizedSha256 ? [deleteArtifact("normalized", s.normalizedSha256)] : []),
    ]),
  );
  vi.unstubAllEnvs();
  resetEvidenceEnv();
  await endPools();
});

const percentile = (sorted: number[], p: number) =>
  sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? Number.NaN;

test(`sealCapture p95 under 400 ms with real R2 and a signer as slow as KMS`, {
  timeout: 180_000,
}, async () => {
  // A warm function reuses its connections, so the first seal pays the handshakes alone.
  const seal = (record: boolean) =>
    withSystem("evidence.test", async (tx) => {
      const input = sealInputFor(newCaptureId(), RESPONSE_BYTES);
      const start = performance.now();
      const result = await sealCapture(input, { tx });
      const ms = performance.now() - start;
      sealed.push(result);
      return record ? ms : null;
    });
  await seal(false);
  const timings: number[] = [];
  for (let i = 0; i < SEALS; i++) {
    const ms = await seal(true);
    if (ms !== null) timings.push(ms);
  }
  timings.sort((a, b) => a - b);
  const [p50, p95] = [percentile(timings, 50), percentile(timings, 95)];
  console.info(
    `sealCapture over ${SEALS} seals: p50 ${p50.toFixed(0)} ms, p95 ${p95.toFixed(0)} ms`,
  );
  expect(p95).toBeLessThan(400);
});
