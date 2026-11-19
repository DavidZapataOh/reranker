import { randomBytes, randomUUID } from "node:crypto";
import { endPools, withSystem } from "@reranker/db";
import type { JobContext } from "@reranker/jobs";
import { sendOpsAlert } from "@reranker/telemetry";
import { type SQL, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { resetEvidenceEnv } from "../src/env";
import { LogForkError } from "../src/errors";
import { publishJob } from "../src/jobs";
import { integrate } from "../src/log/integrate";
import { publishPendingBatches, readHashes } from "../src/log/tiles";
import {
  entryBundlePath,
  type Hash,
  newTiles,
  proveRecord,
  proveTree,
  storedHashes,
  tilePath,
  treeHash,
} from "../src/log/tlog";
import { loadSigner } from "../src/signer";
import { previewEnv } from "./support/evidence-env";
import { localSigner } from "./support/local-signer";
import { publishedLogTiles } from "./support/log-tiles";

vi.mock("../src/signer", () => ({ loadSigner: vi.fn() }));
vi.mock("@reranker/telemetry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@reranker/telemetry")>()),
  sendOpsAlert: vi.fn(async () => {}),
}));

// The log is one index space, so the evidence suites run one file at a time (see package.json)
// and this one integrates and publishes alone. The fake bucket starts with the tiles a suite that
// ran before it published, as the real bucket would hold them.
const ORIGIN = "log-preview.reranker.co/captures/2026";
const PREFIX = "captures/2026/";
const CHECKPOINT = `${PREFIX}checkpoint`;
const signer = localSigner("rr-log-preview-1");
const jobContext: JobContext = {
  attempt: 1,
  jobId: "evidence.publish:test",
  signal: new AbortController().signal,
};

type Integrated = { treeSize: number; firstIndex: number };
type Stored = { body: Uint8Array<ArrayBuffer>; headers: Record<string, string> };

/** The log bucket behind the S3 API, recording the order of the objects it stores. */
const bucket = {
  objects: new Map<string, Stored>(),
  puts: [] as string[],
  putsBeforeFailure: Number.POSITIVE_INFINITY,
  async fetch(request: Request): Promise<Response> {
    const key = decodeURIComponent(new URL(request.url).pathname).replace(
      /^\/rr-log-preview\//,
      "",
    );
    if (request.method === "GET") {
      const object = bucket.objects.get(key);
      return object ? new Response(object.body) : new Response(null, { status: 404 });
    }
    if (bucket.putsBeforeFailure-- <= 0) return new Response(null, { status: 403 });
    if (request.headers.get("if-none-match") === "*" && bucket.objects.has(key)) {
      return new Response(null, { status: 412 });
    }
    const body = new Uint8Array(await request.arrayBuffer());
    bucket.objects.set(key, { body, headers: Object.fromEntries(request.headers) });
    bucket.puts.push(key);
    return new Response(null, { status: 200 });
  },
};

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
const query = <T extends Record<string, unknown>>(q: SQL) =>
  withSystem("evidence.test", async (tx) => (await tx.execute<T>(q)).rows);

/** n entries waiting for the log, in one statement. */
async function seedEntries(n: number): Promise<void> {
  const refs = Array.from({ length: n }, () => randomUUID());
  const digests = Array.from({ length: n }, () => randomBytes(32).toString("hex"));
  await query(sql`
    insert into public_panel.evidence_entries (ref, kind, envelope_sha256)
    select v.ref, 'consent', decode(v.envelope, 'hex')
    from unnest(${sql.param(refs)}::text[], ${sql.param(digests)}::text[]) as v(ref, envelope)`);
}

async function integrateOnce(): Promise<Integrated> {
  const result = await integrate(ORIGIN);
  if (result.status !== "integrated") throw new Error(`integrate returned ${result.status}`);
  return result;
}

async function batch(treeSize: number) {
  const [row] = await query<{ root: Buffer; checkpoint_note: string; published_at: Date | null }>(
    sql`select root, checkpoint_note, published_at from public_panel.evidence_batches
        where origin = ${ORIGIN} and tree_size = ${treeSize}`,
  );
  if (!row) throw new Error(`No batch of size ${treeSize}`);
  return row;
}

/** Every entry of the log below `treeSize`, in index order. */
async function entries(treeSize: number): Promise<Uint8Array[]> {
  const rows = await query<{ envelope_sha256: Buffer }>(sql`
    select log_index, envelope_sha256 from public_panel.captures where log_index < ${treeSize}
    union all
    select log_index, envelope_sha256 from public_panel.evidence_entries where log_index < ${treeSize}
    order by log_index`);
  return rows.map((row) => new Uint8Array(row.envelope_sha256));
}

/** The stored hashes of the whole log, computed from Postgres alone. */
async function localHashes(treeSize: number) {
  const store: Hash[] = [];
  const read = async (indexes: number[]) => indexes.map((index) => store[index] as Hash);
  for (const [n, entry] of (await entries(treeSize)).entries()) {
    store.push(...(await storedHashes(n, entry, read)));
  }
  return read;
}

const object = (key: string) => bucket.objects.get(key) as Stored;

beforeAll(async () => {
  for (const [name, value] of Object.entries(previewEnv)) vi.stubEnv(name, value);
  resetEvidenceEnv();
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) =>
    bucket.fetch(new Request(input, init)),
  );
  for (const [key, body] of await publishedLogTiles(ORIGIN)) {
    bucket.objects.set(key, { body: new Uint8Array(body), headers: {} });
  }
});

afterAll(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  resetEvidenceEnv();
  await endPools();
});

beforeEach(async () => {
  vi.mocked(loadSigner).mockResolvedValue(signer);
  vi.mocked(sendOpsAlert).mockClear();
  bucket.putsBeforeFailure = Number.POSITIVE_INFINITY;
  // Batches other suites integrated without publishing.
  await publishPendingBatches(ORIGIN);
  bucket.puts.length = 0;
});

describe("publishPendingBatches", () => {
  test("writes hash tiles and entry bundles first and the checkpoint last", async () => {
    await seedEntries(300);
    const { firstIndex, treeSize } = await integrateOnce();
    expect(await publishPendingBatches(ORIGIN)).toEqual({ published: [treeSize] });

    const tiles = newTiles(firstIndex, treeSize);
    const expected = tiles.flatMap((tile) =>
      tile.level === 0 ? [tilePath(tile), entryBundlePath(tile.n, tile.width)] : [tilePath(tile)],
    );
    expect(bucket.puts.slice(0, -1).sort()).toEqual(expected.map((path) => PREFIX + path).sort());
    expect(bucket.puts.at(-1)).toBe(CHECKPOINT);

    const { checkpoint_note, published_at } = await batch(treeSize);
    expect(published_at).not.toBeNull();
    expect(new TextDecoder().decode(object(CHECKPOINT).body)).toBe(checkpoint_note);
    // c2sp.org/tlog-tiles: the checkpoint must not be cached beyond a few seconds.
    expect(object(CHECKPOINT).headers).toMatchObject({
      "cache-control": "no-cache",
      "content-type": "text/plain; charset=utf-8",
    });
    // 300 entries always complete a tile.
    const full = tiles.find((tile) => tile.width === 256);
    if (!full) throw new Error("No full tile was written");
    expect(object(PREFIX + tilePath(full)).headers).toMatchObject({
      "cache-control": "public, max-age=31536000, immutable",
      "content-type": "application/octet-stream",
    });
  });

  test("the published tiles lead to the signed root and serve the proofs Postgres implies", async () => {
    await seedEntries(40);
    const before = await integrateOnce();
    await seedEntries(300);
    const { treeSize } = await integrateOnce();
    await publishPendingBatches(ORIGIN);

    const fromTiles = readHashes(ORIGIN, treeSize);
    const local = await localHashes(treeSize);
    expect(hex(await treeHash(treeSize, fromTiles))).toBe(hex((await batch(treeSize)).root));
    for (const n of [0, 255, 256, before.treeSize - 1, treeSize - 1]) {
      expect((await proveRecord(treeSize, n, fromTiles)).map(hex)).toEqual(
        (await proveRecord(treeSize, n, local)).map(hex),
      );
    }
    expect((await proveTree(treeSize, before.treeSize, fromTiles)).map(hex)).toEqual(
      (await proveTree(treeSize, before.treeSize, local)).map(hex),
    );

    // Full tiles never change, so a second reader takes the first one from memory.
    const gets = vi.spyOn(bucket, "fetch");
    await readHashes(ORIGIN, treeSize)([0]);
    expect(gets).not.toHaveBeenCalled();
    gets.mockRestore();
  });

  test("entry bundles are big-endian uint16 length-prefixed entries", async () => {
    await seedEntries(20);
    const { firstIndex, treeSize } = await integrateOnce();
    await publishPendingBatches(ORIGIN);

    const tile = newTiles(firstIndex, treeSize).find((t) => t.level === 0);
    if (!tile) throw new Error("No level-0 tile");
    const bundle = object(PREFIX + entryBundlePath(tile.n, tile.width)).body;
    const all = await entries(treeSize);
    const expected = all.slice(tile.n * 256, tile.n * 256 + tile.width);
    expect(bundle).toHaveLength(tile.width * 34);
    const records = expected.map((_, i) => hex(bundle.subarray(i * 34, (i + 1) * 34)));
    expect(records).toEqual(expected.map((entry) => `0020${hex(entry)}`));
  });

  test("a publication that dies midway is finished before the log grows again", async () => {
    await seedEntries(10);
    const first = await integrateOnce();
    bucket.putsBeforeFailure = 2;
    await expect(publishPendingBatches(ORIGIN)).rejects.toThrow(/403/);
    expect((await batch(first.treeSize)).published_at).toBeNull();

    // While R2 refuses the batch, no checkpoint is signed past it.
    await seedEntries(5);
    await expect(integrate(ORIGIN)).rejects.toThrow(/403/);

    bucket.putsBeforeFailure = Number.POSITIVE_INFINITY;
    const second = await integrateOnce();
    expect(second.firstIndex).toBe(first.treeSize);
    expect((await batch(first.treeSize)).published_at).not.toBeNull();
    expect((await batch(second.treeSize)).published_at).toBeNull();
    expect(new TextDecoder().decode(object(CHECKPOINT).body)).toBe(
      (await batch(first.treeSize)).checkpoint_note,
    );
    expect(await publishPendingBatches(ORIGIN)).toEqual({ published: [second.treeSize] });
  });

  test("a tile already served with other bytes stops publication and alerts", async () => {
    await seedEntries(3);
    const { firstIndex, treeSize } = await integrateOnce();
    const [tile] = newTiles(firstIndex, treeSize);
    if (!tile) throw new Error("The batch has no tile");
    const key = PREFIX + tilePath(tile);
    bucket.objects.set(key, { body: randomBytes(32), headers: {} });

    await expect(publishPendingBatches(ORIGIN)).rejects.toBeInstanceOf(LogForkError);
    expect(sendOpsAlert).toHaveBeenCalledWith("evidence-log-fork", { origin: ORIGIN, key });
    expect((await batch(treeSize)).published_at).toBeNull();

    bucket.objects.delete(key);
    expect(await publishPendingBatches(ORIGIN)).toEqual({ published: [treeSize] });
  });
});

describe("evidence.publish job", () => {
  test("publishes the batches integration left", async () => {
    await seedEntries(2);
    const { treeSize } = await integrateOnce();
    await publishJob.handler({ origin: ORIGIN }, jobContext);
    expect((await batch(treeSize)).published_at).not.toBeNull();
  });
});
