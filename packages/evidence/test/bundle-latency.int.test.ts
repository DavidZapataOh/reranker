import { gunzipSync } from "node:zlib";
import { endPools, withSystem } from "@reranker/db";
import { InvalidInputError } from "@reranker/jobs/errors";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, expect, test, vi } from "vitest";
import { probeBuildBundle } from "../src/bundle-latency";
import { resetEvidenceEnv } from "../src/env";
import { previewEnv } from "./support/evidence-env";

// Both buckets as aws4fetch sees them, objects stored as fetch hands them back.
const r2 = new Map<string, Uint8Array<ArrayBuffer>>();
let puts = 0;
let failDeletes = false;

async function fakeR2(request: Request): Promise<Response> {
  const key = decodeURIComponent(new URL(request.url).pathname).slice(1);
  if (request.method === "PUT") {
    puts++;
    if (request.headers.get("if-none-match") === "*" && r2.has(key)) {
      return new Response(null, { status: 412 });
    }
    const body = new Uint8Array(await request.arrayBuffer());
    r2.set(key, request.headers.get("content-encoding") === "gzip" ? gunzipSync(body) : body);
    return new Response(null, { status: 200 });
  }
  if (request.method === "DELETE") {
    if (failDeletes) return new Response(null, { status: 503 });
    r2.delete(key);
    return new Response(null, { status: 204 });
  }
  const body = r2.get(key);
  return body ? new Response(body) : new Response(null, { status: 404 });
}

const probeRows = async () => {
  const { rows } = await withSystem("evidence.test", (tx) =>
    tx.execute<{ captures: number; logRows: number }>(sql`
      select
        (select count(*)::int from public_panel.captures where intent_id = 'latency-probe')
          as captures,
        (select count(*)::int from public_panel.evidence_batches
         where origin like '%/latency-probe/%')
          + (select count(*)::int from public_panel.evidence_tree_hashes
             where origin like '%/latency-probe/%')
          + (select count(*)::int from public_panel.evidence_entries
             where ref like '%/latency-probe/%') as "logRows"`),
  );
  return rows[0];
};

afterAll(() => endPools());

beforeEach(() => {
  for (const [name, value] of Object.entries(previewEnv)) vi.stubEnv(name, value);
  vi.stubEnv("VERCEL_REGION", "iad1");
  vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "fedcba9876543210fedcba9876543210fedcba98");
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) =>
    fakeR2(new Request(input, init)),
  );
  resetEvidenceEnv();
  r2.clear();
  puts = 0;
  failDeletes = false;
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  resetEvidenceEnv();
});

test("times whole bundles and each part, then leaves no object and no row behind", {
  timeout: 120_000,
}, async () => {
  const report = await probeBuildBundle(2);

  for (const part of Object.values(report)) {
    expect(part).toEqual({ p50: expect.any(Number), p95: expect.any(Number), n: 2 });
  }
  expect(puts).toBeGreaterThan(0);
  expect(r2.size).toBe(0);
  expect(await probeRows()).toEqual({ captures: 0, logRows: 0 });
});

test("fails rather than report numbers when its objects cannot be deleted", {
  timeout: 120_000,
}, async () => {
  failDeletes = true;
  await expect(probeBuildBundle(1)).rejects.toThrow(/probe objects were not deleted/);
  expect(await probeRows()).toEqual({ captures: 0, logRows: 0 });
});

test.each([0, 201, 1.5])("refuses %s bundles before writing anything", async (n) => {
  await expect(probeBuildBundle(n)).rejects.toBeInstanceOf(InvalidInputError);
  expect(puts).toBe(0);
});
