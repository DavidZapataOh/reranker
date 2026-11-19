import { withSystem } from "@reranker/db";
import { sql } from "drizzle-orm";
import {
  type Hash,
  newTiles,
  storedHashes,
  storedHashIndex,
  TILE_HEIGHT,
  tilePath,
} from "../../src/log/tlog";

/**
 * The hash tiles of the newest published tree of `origin`, keyed as in the log bucket and rebuilt
 * from Postgres. Each suite has its own in-memory bucket, so one that publishes after another
 * suite already did starts from these, as the real bucket would hold them.
 */
export async function publishedLogTiles(origin: string): Promise<Map<string, Uint8Array>> {
  const tiles = new Map<string, Uint8Array>();
  const { rows: batches } = await withSystem("evidence.test", (tx) =>
    tx.execute<{ tree_size: string }>(sql`
      select tree_size from public_panel.evidence_batches
      where origin = ${origin} and published_at is not null
      order by tree_size desc limit 1`),
  );
  const treeSize = Number(batches[0]?.tree_size ?? 0);
  if (treeSize === 0) return tiles;

  const { rows: entries } = await withSystem("evidence.test", (tx) =>
    tx.execute<{ envelope_sha256: Buffer }>(sql`
      select log_index, envelope_sha256 from public_panel.captures where log_index < ${treeSize}
      union all
      select log_index, envelope_sha256 from public_panel.evidence_entries
      where log_index < ${treeSize}
      order by log_index`),
  );
  const store: Hash[] = [];
  const read = async (indexes: number[]) => indexes.map((index) => store[index] as Hash);
  for (const [n, entry] of entries.entries()) {
    store.push(...(await storedHashes(n, new Uint8Array(entry.envelope_sha256), read)));
  }

  const prefix = `${origin.slice(origin.indexOf("/") + 1)}/`;
  for (const tile of newTiles(0, treeSize)) {
    const start = tile.n * 2 ** TILE_HEIGHT;
    const hashes = Array.from(
      { length: tile.width },
      (_, i) => store[storedHashIndex(tile.level * TILE_HEIGHT, start + i)] as Hash,
    );
    tiles.set(prefix + tilePath(tile), Buffer.concat(hashes));
  }
  return tiles;
}
