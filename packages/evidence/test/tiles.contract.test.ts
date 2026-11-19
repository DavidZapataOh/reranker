import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { endPools, withSystem } from "@reranker/db";
import { requireEnv } from "@reranker/testing/env";
import { noteVerifierKey } from "@reranker/verify/trust";
import { AwsClient } from "aws4fetch";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { resetEvidenceEnv } from "../src/env";
import { integrate } from "../src/log/integrate";
import { publishPendingBatches } from "../src/log/tiles";
import { loadSigner } from "../src/signer";
import { previewEnv } from "./support/evidence-env";
import { localSigner } from "./support/local-signer";

vi.mock("../src/signer", () => ({ loadSigner: vi.fn() }));

// The preview log bucket, written with the bucket-scoped CI key under a path of its own: a tile
// path is immutable, so every run needs a log nobody published before. It is deleted at the end.
const ACCOUNT_ID = requireEnv("CLOUDFLARE_ACCOUNT_ID");
const BUCKET = "rr-log-preview";
const PREFIX = `ci/${randomUUID()}`;
const ORIGIN = `log-preview.reranker.co/${PREFIX}/captures/2026`;
const signer = localSigner("rr-log-preview-1");
const run = promisify(execFile);

const r2 = new AwsClient({
  accessKeyId: requireEnv("R2_ACCESS_KEY_ID_CI"),
  secretAccessKey: requireEnv("R2_SECRET_ACCESS_KEY_CI"),
  service: "s3",
  region: "auto",
});
const endpoint = `https://${ACCOUNT_ID}.r2.cloudflarestorage.com/${BUCKET}`;

async function seedEntries(n: number): Promise<void> {
  const refs = Array.from({ length: n }, () => randomUUID());
  const digests = Array.from({ length: n }, () => randomBytes(32).toString("hex"));
  await withSystem("evidence.test", (tx) =>
    tx.execute(sql`
      insert into public_panel.evidence_entries (ref, kind, envelope_sha256)
      select v.ref, 'consent', decode(v.envelope, 'hex')
      from unnest(${sql.param(refs)}::text[], ${sql.param(digests)}::text[]) as v(ref, envelope)`),
  );
}

async function integrateAndPublish(): Promise<void> {
  expect((await integrate(ORIGIN)).status).toBe("integrated");
  expect((await publishPendingBatches(ORIGIN)).published).toHaveLength(1);
}

beforeAll(() => {
  for (const [name, value] of Object.entries(previewEnv)) vi.stubEnv(name, value);
  vi.stubEnv("R2_ACCOUNT_ID", ACCOUNT_ID);
  vi.stubEnv("R2_ACCESS_KEY_ID", requireEnv("R2_ACCESS_KEY_ID_CI"));
  vi.stubEnv("R2_SECRET_ACCESS_KEY", requireEnv("R2_SECRET_ACCESS_KEY_CI"));
  vi.stubEnv("R2_LOG_BUCKET", BUCKET);
  resetEvidenceEnv();
  vi.mocked(loadSigner).mockResolvedValue(signer);
});

afterAll(async () => {
  // A run writes a handful of tiles, far below one ListObjectsV2 page.
  const list = await r2.fetch(`${endpoint}?list-type=2&prefix=${encodeURIComponent(`${PREFIX}/`)}`);
  const keys = [...(await list.text()).matchAll(/<Key>([^<]+)<\/Key>/g)].map(([, key]) => key);
  await Promise.all(
    keys.map(async (key) =>
      (await r2.fetch(`${endpoint}/${key}`, { method: "DELETE" })).body?.cancel(),
    ),
  );
  vi.unstubAllEnvs();
  resetEvidenceEnv();
  await endPools();
});

test("Go's TileHashReader recomputes the published checkpoint from the public tiles", async () => {
  await seedEntries(300);
  await integrateAndPublish();
  // A second batch grows the partial tiles the first one left.
  await seedEntries(20);
  await integrateAndPublish();

  const { stdout } = await run(
    "go",
    ["run", ".", "tiles-verify", `https://${ORIGIN}`, noteVerifierKey(ORIGIN, signer.publicKey)],
    { cwd: new URL("./go/", import.meta.url) },
  );
  expect(stdout).toMatch(/^OK \d+\n$/);
  expect(Number(stdout.split(" ")[1])).toBeGreaterThanOrEqual(320);
  // The first run downloads the Go module.
}, 180_000);
