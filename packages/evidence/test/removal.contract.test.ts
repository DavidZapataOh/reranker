import { randomUUID } from "node:crypto";
import { endPools, withSystem } from "@reranker/db";
import { requireEnv } from "@reranker/testing/env";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { artifactUrl, putArtifact } from "../src/artifacts";
import { resetEvidenceEnv } from "../src/env";
import { removeArtifact } from "../src/removal";

// The preview evidence bucket behind ev-preview.reranker.co, written with the bucket-scoped CI key
// and purged through the zone's API token.
beforeAll(() => {
  vi.stubEnv("APP_ENV", "preview");
  vi.stubEnv("R2_ACCOUNT_ID", requireEnv("CLOUDFLARE_ACCOUNT_ID"));
  vi.stubEnv("R2_ACCESS_KEY_ID", requireEnv("R2_ACCESS_KEY_ID_CI"));
  vi.stubEnv("R2_SECRET_ACCESS_KEY", requireEnv("R2_SECRET_ACCESS_KEY_CI"));
  vi.stubEnv("R2_EVIDENCE_BUCKET", "rr-evidence-preview");
  vi.stubEnv("R2_INTERNAL_BUCKET", "rr-internal-preview");
  vi.stubEnv("EVIDENCE_ARTIFACTS_BASE_URL", "https://ev-preview.reranker.co");
  vi.stubEnv("CLOUDFLARE_CACHE_PURGE_TOKEN", requireEnv("CLOUDFLARE_API_TOKEN"));
  vi.stubEnv("CLOUDFLARE_ZONE_ID", requireEnv("CLOUDFLARE_ZONE_ID"));
  resetEvidenceEnv();
});

afterAll(async () => {
  vi.unstubAllEnvs();
  resetEvidenceEnv();
  await endPools();
});

test("a removed artifact answers 404 on its public URL within 60 s", async () => {
  const bytes = new TextEncoder().encode(JSON.stringify({ run: randomUUID(), at: Date.now() }));
  const { sha256 } = await putArtifact("raw", bytes, { contentType: "application/json" });
  const url = artifactUrl("raw", sha256);
  // Two reads, so the edge holds a cached copy the purge has to evict.
  for (let i = 0; i < 2; i++) {
    const response = await fetch(url);
    await response.body?.cancel();
    expect(response.status).toBe(200);
  }

  const started = performance.now();
  await removeArtifact(sha256, "raw", "personal_data_request");
  let status = 200;
  while (performance.now() - started < 60_000) {
    const response = await fetch(url, { cache: "no-store" });
    await response.body?.cancel();
    status = response.status;
    if (status === 404) break;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  expect(status).toBe(404);

  const { rows } = await withSystem("evidence.test", (tx) =>
    tx.execute<{ reason: string }>(sql`
      select reason from public_panel.artifact_removals where sha256 = decode(${sha256}, 'hex')`),
  );
  expect(rows).toEqual([{ reason: "personal_data_request" }]);
}, 90_000);
