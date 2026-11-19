import { type SystemTx, withSystem } from "@reranker/db";
import { evidenceBatches } from "@reranker/db/schema";
import { sendOpsAlert } from "@reranker/telemetry";
import { nodeHash } from "@reranker/verify/format";
import { and, desc, eq, isNull, lt, sql } from "drizzle-orm";
import { getLogObject, putLogObject } from "../artifacts";
import { LogForkError } from "../errors";
import {
  entryBundlePath,
  type Hash,
  newTiles,
  type ReadHashes,
  splitStoredHashIndex,
  storedHashes,
  storedHashIndex,
  TILE_HEIGHT,
  type Tile,
  tilePath,
  treeHash,
} from "./tlog";

const TILE_WIDTH = 2 ** TILE_HEIGHT;
const HASH_BYTES = 32;
const OCTETS = "application/octet-stream";
// At most 8 MiB: 1,024 full tiles hold the hashes of 262,144 entries.
const TILE_CACHE = 1024;
const BATCH_PAGE = 100;

const tileCache = new Map<string, Promise<Uint8Array>>();

/** Key prefix of a log's objects: C2SP tlog-tiles serves it at its origin, without the host. */
function prefixOf(origin: string): string {
  const slash = origin.indexOf("/");
  return slash === -1 ? "" : `${origin.slice(slash + 1)}/`;
}

// tileForIndex from golang.org/x/mod/sumdb/tlog (tile.go): the narrowest tile holding stored hash
// `index`, and the byte range of the tile hashes that fold into it.
function tileForIndex(index: number): { tile: Tile; start: number; end: number } {
  const stored = splitStoredHashIndex(index);
  const level = Math.floor(stored.level / TILE_HEIGHT);
  const levelInTile = stored.level - level * TILE_HEIGHT;
  const span = 2 ** levelInTile;
  const n = Math.floor((stored.n * span) / TILE_WIDTH);
  const nInTile = stored.n - (n * TILE_WIDTH) / span;
  return {
    tile: { height: TILE_HEIGHT, level, n, width: (nInTile + 1) * span },
    start: nInTile * span * HASH_BYTES,
    end: (nInTile + 1) * span * HASH_BYTES,
  };
}

// tileHash from sumdb/tlog: the subtree hash of a power-of-two run of tile hashes.
function tileHash(data: Uint8Array): Hash {
  if (data.length === HASH_BYTES) return data;
  const half = data.length / 2;
  return nodeHash(tileHash(data.subarray(0, half)), tileHash(data.subarray(half)));
}

async function fetchTile(key: string, width: number): Promise<Uint8Array> {
  const data = await getLogObject(key);
  if (data === null) throw new Error(`Transparency log tile ${key} is missing`);
  if (data.length !== width * HASH_BYTES) {
    throw new LogForkError(key, `holds ${data.length} bytes instead of ${width} hashes`);
  }
  return data;
}

// Every tile path names immutable bytes, a partial one included (its width is in the path), so
// any tile once read is served from memory, least recently used out first. Readers of a tile
// still in flight share its request; a failed read is forgotten so the next one retries.
function readTile(key: string, width: number): Promise<Uint8Array> {
  const cached = tileCache.get(key);
  if (cached !== undefined) {
    tileCache.delete(key);
    tileCache.set(key, cached);
    return cached;
  }
  const read = fetchTile(key, width);
  read.catch(() => {
    if (tileCache.get(key) === read) tileCache.delete(key);
  });
  const oldest = tileCache.keys().next();
  if (tileCache.size >= TILE_CACHE && !oldest.done) tileCache.delete(oldest.value);
  tileCache.set(key, read);
  return read;
}

/**
 * Reads stored hashes of the tree of `treeSize` entries from the published tiles, as
 * sumdb/tlog's TileHashReader does without re-authenticating them: they are the log's own.
 */
export function readHashes(origin: string, treeSize: number): ReadHashes {
  const prefix = prefixOf(origin);
  const end = storedHashIndex(0, treeSize);
  const tiles = new Map<string, Promise<Uint8Array>>();
  return (indexes) =>
    Promise.all(
      indexes.map(async (index) => {
        if (!Number.isSafeInteger(index) || index < 0 || index >= end) {
          throw new RangeError(`Stored hash ${index} is not in a tree of ${treeSize}`);
        }
        const { tile, start, end: stop } = tileForIndex(index);
        // The tile as published for this tree: full, or partial up to its last entry.
        const max = Math.floor(treeSize / TILE_WIDTH ** tile.level) - tile.n * TILE_WIDTH;
        const width = Math.min(TILE_WIDTH, max);
        const key = prefix + tilePath({ ...tile, width });
        let data = tiles.get(key);
        if (!data) {
          data = readTile(key, width);
          tiles.set(key, data);
        }
        return tileHash((await data).subarray(start, stop));
      }),
    );
}

type Batch = { treeSize: number; firstIndex: number; root: Buffer; checkpointNote: string };

// Batches are published in tree order, so the unpublished ones are the newest: walk back along
// the primary key until a published one.
async function unpublishedBatches(tx: SystemTx, origin: string): Promise<Batch[]> {
  const batches: Batch[] = [];
  for (let below = Number.MAX_SAFE_INTEGER; ; ) {
    const page = await tx
      .select({
        treeSize: evidenceBatches.treeSize,
        firstIndex: evidenceBatches.firstIndex,
        root: evidenceBatches.root,
        checkpointNote: evidenceBatches.checkpointNote,
        publishedAt: evidenceBatches.publishedAt,
      })
      .from(evidenceBatches)
      .where(and(eq(evidenceBatches.origin, origin), lt(evidenceBatches.treeSize, below)))
      .orderBy(desc(evidenceBatches.treeSize))
      .limit(BATCH_PAGE);
    for (const { publishedAt, ...batch } of page) {
      if (publishedAt !== null) return batches.reverse();
      batches.push(batch);
    }
    const last = page.at(-1);
    if (!last || page.length < BATCH_PAGE) return batches.reverse();
    below = last.treeSize;
  }
}

/** The log entries (envelope digests) with indexes from..to-1, captures and statements alike. */
async function entriesBetween(tx: SystemTx, from: number, to: number): Promise<Uint8Array[]> {
  const { rows } = await tx.execute<{ log_index: string; envelope_sha256: Buffer }>(sql`
    select log_index, envelope_sha256 from public_panel.captures
    where log_index >= ${from} and log_index < ${to}
    union all
    select log_index, envelope_sha256 from public_panel.evidence_entries
    where log_index >= ${from} and log_index < ${to}
    order by log_index`);
  if (rows.length !== to - from || rows.some((row, i) => Number(row.log_index) !== from + i)) {
    throw new Error(`The log entries ${from}..${to - 1} are not all in Postgres`);
  }
  return rows.map((row) => new Uint8Array(row.envelope_sha256));
}

/** Writes an immutable object once; an earlier write must hold the very same bytes. */
async function putOnce(key: string, bytes: Uint8Array<ArrayBuffer>): Promise<void> {
  if ((await putLogObject(key, bytes, { immutable: true, contentType: OCTETS })).created) return;
  // A retry after a publication that died midway finds its own bytes.
  const existing = await getLogObject(key);
  if (existing === null || Buffer.compare(existing, bytes) !== 0) {
    throw new LogForkError(key, "already holds other bytes");
  }
}

// c2sp.org/tlog-tiles: big-endian uint16 length-prefixed entries.
function entryBundle(entries: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const bundle = Buffer.alloc(entries.reduce((size, entry) => size + 2 + entry.length, 0));
  let at = 0;
  for (const entry of entries) {
    at = bundle.writeUInt16BE(entry.length, at);
    bundle.set(entry, at);
    at += entry.length;
  }
  return bundle;
}

/** `entries` starts at the first entry of the level-0 tile that holds `batch.firstIndex`. */
async function publishBatch(origin: string, batch: Batch, entries: Uint8Array[]): Promise<void> {
  const { firstIndex, treeSize } = batch;
  const prefix = prefixOf(origin);
  const entriesFrom = treeSize - entries.length;
  const published = readHashes(origin, firstIndex);
  const fresh = new Map<number, Hash>();
  const read: ReadHashes = async (indexes) => {
    const old = indexes.filter((index) => !fresh.has(index));
    const oldHashes = new Map((await published(old)).map((hash, i) => [old[i] as number, hash]));
    return indexes.map((index) => (fresh.get(index) ?? oldHashes.get(index)) as Hash);
  };
  for (let n = firstIndex; n < treeSize; n++) {
    const first = storedHashIndex(0, n);
    const hashes = await storedHashes(n, entries[n - entriesFrom] as Uint8Array, read);
    for (const [i, hash] of hashes.entries()) fresh.set(first + i, hash);
  }
  // Nothing of this batch is served unless the published tiles extend to its signed root.
  if (Buffer.compare(await treeHash(treeSize, read), batch.root) !== 0) {
    throw new LogForkError(
      `${prefix}tile`,
      `published tiles do not lead to the root of ${treeSize}`,
    );
  }

  await Promise.all(
    newTiles(firstIndex, treeSize).map(async (tile) => {
      const start = tile.n * TILE_WIDTH;
      const indexes = Array.from({ length: tile.width }, (_, i) =>
        storedHashIndex(tile.level * TILE_HEIGHT, start + i),
      );
      const writes = [putOnce(prefix + tilePath(tile), Buffer.concat(await read(indexes)))];
      if (tile.level === 0) {
        const bundle = entries.slice(start - entriesFrom, start - entriesFrom + tile.width);
        writes.push(putOnce(prefix + entryBundlePath(tile.n, tile.width), entryBundle(bundle)));
      }
      await Promise.all(writes);
    }),
  );
  // Last, so a reader never sees a checkpoint whose tiles are not there yet.
  await putLogObject(`${prefix}checkpoint`, new TextEncoder().encode(batch.checkpointNote), {
    immutable: false,
    contentType: "text/plain; charset=utf-8",
  });
}

/**
 * Publishes the tiles, entry bundles and checkpoint of every integrated batch of `origin` not
 * yet public, oldest first, and returns their tree sizes. A run that dies midway leaves the rest
 * for the next one, which rewrites nothing that differs.
 */
export async function publishPendingBatches(origin: string): Promise<{ published: number[] }> {
  const published: number[] = [];
  let failure: unknown;
  await withSystem(
    "evidence.publish",
    async (tx) => {
      // Publishers of one origin take turns, so checkpoints are served in tree order.
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext('public_panel.evidence_batches.publish'), hashtext(${origin}))`,
      );
      for (const batch of await unpublishedBatches(tx, origin)) {
        try {
          const from = batch.firstIndex - (batch.firstIndex % TILE_WIDTH);
          await publishBatch(origin, batch, await entriesBetween(tx, from, batch.treeSize));
        } catch (error) {
          // Commit what is already public; the failed batch stays unpublished.
          failure = error;
          return;
        }
        await tx
          .update(evidenceBatches)
          .set({ publishedAt: sql`now()` })
          .where(
            and(
              eq(evidenceBatches.origin, origin),
              eq(evidenceBatches.treeSize, batch.treeSize),
              isNull(evidenceBatches.publishedAt),
            ),
          );
        published.push(batch.treeSize);
      }
    },
    { statementTimeoutMs: 30_000 },
  );
  if (failure instanceof LogForkError) {
    await sendOpsAlert("evidence-log-fork", { origin, key: failure.key });
  }
  if (failure !== undefined) throw failure;
  return { published };
}
