import { randomUUID } from "node:crypto";
import { requireEnv } from "@reranker/testing/env";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { artifactUrl, deleteArtifact, getArtifact, putArtifact } from "../src/artifacts";
import { resetEvidenceEnv } from "../src/env";

// The preview buckets, written with the bucket-scoped CI key; every object a run creates is
// deleted before it ends.
const ACCOUNT_ID = requireEnv("CLOUDFLARE_ACCOUNT_ID");
const PUBLIC_BASE = "https://ev-preview.reranker.co";
const INTERNAL_BUCKET = "rr-internal-preview";

const written: Array<{ kind: "raw" | "extractions"; sha256: string }> = [];
const unique = () =>
  new TextEncoder().encode(JSON.stringify({ run: randomUUID(), at: Date.now() }));

beforeAll(() => {
  vi.stubEnv("APP_ENV", "preview");
  vi.stubEnv("R2_ACCOUNT_ID", ACCOUNT_ID);
  vi.stubEnv("R2_ACCESS_KEY_ID", requireEnv("R2_ACCESS_KEY_ID_CI"));
  vi.stubEnv("R2_SECRET_ACCESS_KEY", requireEnv("R2_SECRET_ACCESS_KEY_CI"));
  vi.stubEnv("R2_EVIDENCE_BUCKET", "rr-evidence-preview");
  vi.stubEnv("R2_INTERNAL_BUCKET", INTERNAL_BUCKET);
  vi.stubEnv("EVIDENCE_ARTIFACTS_BASE_URL", PUBLIC_BASE);
  resetEvidenceEnv();
});

afterAll(async () => {
  await Promise.all(written.map(({ kind, sha256 }) => deleteArtifact(kind, sha256)));
  vi.unstubAllEnvs();
  resetEvidenceEnv();
});

test("an artifact reads back identical through the S3 API and the public domain", async () => {
  const bytes = unique();
  const first = await putArtifact("raw", bytes, { contentType: "application/json" });
  written.push({ kind: "raw", sha256: first.sha256 });
  expect(first.created).toBe(true);
  expect(await putArtifact("raw", bytes, { contentType: "application/json" })).toEqual({
    sha256: first.sha256,
    created: false,
  });

  expect(await getArtifact("raw", first.sha256)).toEqual(bytes);

  const response = await fetch(artifactUrl("raw", first.sha256));
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);

  await deleteArtifact("raw", first.sha256);
  expect(await getArtifact("raw", first.sha256)).toBeNull();
});

test("an extraction is stored but answers on no public domain", async () => {
  const bytes = unique();
  const { sha256 } = await putArtifact("extractions", bytes, { contentType: "application/json" });
  written.push({ kind: "extractions", sha256 });
  expect(await getArtifact("extractions", sha256)).toEqual(bytes);

  expect((await fetch(`${PUBLIC_BASE}/extractions/${sha256}`)).status).toBe(404);

  // The bucket itself must have neither r2.dev access nor a custom domain.
  const api = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/r2/buckets/${INTERNAL_BUCKET}/domains`;
  const headers = { Authorization: `Bearer ${requireEnv("CLOUDFLARE_API_TOKEN")}` };
  const managed = await (await fetch(`${api}/managed`, { headers })).json();
  expect(managed).toMatchObject({ success: true, result: { enabled: false } });
  const custom = await (await fetch(`${api}/custom`, { headers })).json();
  expect(custom).toMatchObject({ success: true, result: { domains: [] } });
});

test("p95 of 20 artifact writes", async () => {
  const millis: number[] = [];
  for (let i = 0; i < 20; i++) {
    const bytes = unique();
    const started = performance.now();
    const { sha256 } = await putArtifact("raw", bytes, { contentType: "application/json" });
    millis.push(performance.now() - started);
    written.push({ kind: "raw", sha256 });
  }
  millis.sort((a, b) => a - b);
  const p95 = millis[Math.ceil(millis.length * 0.95) - 1] ?? Number.NaN;
  console.info(`R2 putArtifact p95 over 20 writes: ${p95.toFixed(0)} ms`);
  expect(p95).toBeLessThan(5_000);
});
