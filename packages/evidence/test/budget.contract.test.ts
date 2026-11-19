import { randomBytes } from "node:crypto";
import { endPools, withSystem } from "@reranker/db";
import { requireEnv } from "@reranker/testing/env";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { type ArtifactKind, deleteArtifact, putArtifact } from "../src/artifacts";
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
// A runner pays its own distance to the bucket on every R2 write (a GitHub runner in centralus
// waits ~250 ms for one), so CI cannot hold the 400 ms production budget. It holds a seal to one
// round of R2 writes measured from the same runner in the same minutes, plus this for the retry
// check in Postgres and the KMS-like signature that precedes the envelope write.
const BEYOND_ONE_WRITE_ROUND_MS = 150;

const local = localSigner("rr-capture-preview-1-ed25519");
const kmsLike: Signer = {
  ...local,
  sign: async (message) => {
    await new Promise((resolve) => setTimeout(resolve, KMS_SIGN_MS));
    return local.sign(message);
  },
};

const sealed: SealedCapture[] = [];
const written: Array<{ kind: ArtifactKind; sha256: string }> = [];

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
  await Promise.all(written.map(({ kind, sha256 }) => deleteArtifact(kind, sha256)));
  vi.unstubAllEnvs();
  resetEvidenceEnv();
  await endPools();
});

const percentile = (sorted: number[], p: number) =>
  sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? Number.NaN;

// The four objects a seal writes, with fresh bytes so no write is answered by its precondition.
async function writeRound(): Promise<number> {
  const objects: Array<[ArtifactKind, number]> = [
    ["raw", RESPONSE_BYTES],
    ["request", 512],
    ["normalized", 2048],
    ["envelopes", 2048],
  ];
  const start = performance.now();
  const stored = await Promise.all(
    objects.map(async ([kind, size]) => ({
      kind,
      ...(await putArtifact(kind, randomBytes(size), { contentType: "application/json" })),
    })),
  );
  const ms = performance.now() - start;
  written.push(...stored);
  return ms;
}

test(`sealCapture p95 within one R2 write round plus ${BEYOND_ONE_WRITE_ROUND_MS} ms, with a signer as slow as KMS`, {
  timeout: 300_000,
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
  // Interleaved, so both series see the same network.
  const seals: number[] = [];
  const rounds: number[] = [];
  for (let i = 0; i < SEALS; i++) {
    const ms = await seal(true);
    if (ms !== null) seals.push(ms);
    rounds.push(await writeRound());
  }
  seals.sort((a, b) => a - b);
  rounds.sort((a, b) => a - b);
  const [p50, p95] = [percentile(seals, 50), percentile(seals, 95)];
  const roundP95 = percentile(rounds, 95);
  console.info(
    `sealCapture over ${SEALS} seals: p50 ${p50.toFixed(0)} ms, p95 ${p95.toFixed(0)} ms; ` +
      `one R2 write round: p50 ${percentile(rounds, 50).toFixed(0)} ms, p95 ${roundP95.toFixed(0)} ms`,
  );
  expect(p95 - roundP95).toBeLessThan(BEYOND_ONE_WRITE_ROUND_MS);
});
