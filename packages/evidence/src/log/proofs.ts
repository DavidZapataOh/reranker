import { merkleRoot } from "@reranker/verify/format";
import { type SQL, sql } from "drizzle-orm";
import {
  type Hash,
  proveRecord,
  proveTree,
  type ReadHashes,
  splitStoredHashIndex,
  TILE_HEIGHT,
} from "./tlog";

/** Runs one read of the log's rows. */
export type Read = <T extends Record<string, unknown>>(query: SQL) => Promise<T[]>;

type Range = { lo: number; hi: number };
type ProofRow = { source: "node" | "entry"; key: string; hash: Buffer };

const PLACEHOLDER = new Uint8Array(32);

/**
 * The stored hashes an inclusion proof of `index` in the tree of `treeSize` and a consistency
 * proof from it to `latestSize` read, found by running both over placeholders.
 */
export async function proofHashIndexes(
  treeSize: number,
  index: number,
  latestSize: number,
): Promise<number[]> {
  const needed = new Set<number>();
  const record: ReadHashes = async (indexes) => {
    for (const i of indexes) needed.add(i);
    return indexes.map(() => PLACEHOLDER);
  };
  await proveRecord(treeSize, index, record);
  await proveTree(latestSize, treeSize, record);
  return [...needed].sort((a, b) => a - b);
}

// A stored hash below level 8 covers at most 128 entries, so it is recomputed from them; the
// larger ones were stored by integration.
function split(indexes: number[]): { nodes: number[]; ranges: Range[] } {
  const nodes: number[] = [];
  const ranges: Range[] = [];
  for (const index of indexes) {
    const { level, n } = splitStoredHashIndex(index);
    if (level >= TILE_HEIGHT) {
      nodes.push(index);
      continue;
    }
    ranges.push({ lo: n * 2 ** level, hi: (n + 1) * 2 ** level });
  }
  // Stored hash order is not entry order across levels.
  ranges.sort((a, b) => a.lo - b.lo);
  const merged: Range[] = [];
  for (const range of ranges) {
    const last = merged.at(-1);
    if (last && range.lo <= last.hi) last.hi = Math.max(last.hi, range.hi);
    else merged.push({ ...range });
  }
  return { nodes, ranges: merged };
}

/** The stored hashes and entries behind the given stored hash indexes, in one statement. */
export function proofHashesQuery(origin: string, indexes: number[]): SQL {
  const { nodes, ranges } = split(indexes);
  const lo = sql.param(ranges.map((r) => r.lo));
  const hi = sql.param(ranges.map((r) => r.hi));
  return sql`
    select 'node' as source, h.stored_index as key, h.hash
    from public_panel.evidence_tree_hashes h
    where h.origin = ${origin} and h.stored_index = any(${sql.param(nodes)}::bigint[])
    union all
    select 'entry', c.log_index, c.envelope_sha256
    from unnest(${lo}::bigint[], ${hi}::bigint[]) as r(lo, hi)
    join public_panel.captures c on c.log_index >= r.lo and c.log_index < r.hi
    union all
    select 'entry', e.log_index, e.envelope_sha256
    from unnest(${lo}::bigint[], ${hi}::bigint[]) as r(lo, hi)
    join public_panel.evidence_entries e on e.log_index >= r.lo and e.log_index < r.hi`;
}

/**
 * RFC 6962 inclusion and consistency proofs served from Postgres: one statement reads the
 * stored hashes of large subtrees and the entries of small ones, so no tile is fetched.
 */
export async function proveFromDatabase(
  origin: string,
  treeSize: number,
  index: number,
  latestSize: number,
  read: Read,
): Promise<{ inclusion: Hash[]; consistency: Hash[] }> {
  const indexes = await proofHashIndexes(treeSize, index, latestSize);
  const rows = indexes.length === 0 ? [] : await read<ProofRow>(proofHashesQuery(origin, indexes));
  const nodes = new Map<number, Hash>();
  const entries = new Map<number, Uint8Array>();
  for (const row of rows) {
    (row.source === "node" ? nodes : entries).set(Number(row.key), new Uint8Array(row.hash));
  }
  const hashes = new Map<number, Hash>();
  for (const stored of indexes) {
    const { level, n } = splitStoredHashIndex(stored);
    if (level >= TILE_HEIGHT) {
      const hash = nodes.get(stored);
      if (!hash) throw new Error(`Tree hash ${stored} of ${origin} is not in Postgres`);
      hashes.set(stored, hash);
      continue;
    }
    const leaves = Array.from({ length: 2 ** level }, (_, i) => entries.get(n * 2 ** level + i));
    if (leaves.some((leaf) => leaf === undefined)) {
      throw new Error(`Log entries under stored hash ${stored} are not all in Postgres`);
    }
    hashes.set(stored, merkleRoot(leaves as Uint8Array[]));
  }
  const fromMemory: ReadHashes = async (wanted) => wanted.map((i) => hashes.get(i) as Hash);
  const [inclusion, consistency] = await Promise.all([
    proveRecord(treeSize, index, fromMemory),
    proveTree(latestSize, treeSize, fromMemory),
  ]);
  return { inclusion, consistency };
}
