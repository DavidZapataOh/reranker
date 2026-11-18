// Ported from golang.org/x/mod/sumdb/tlog v0.43.0 (tlog.go, tile.go).
// Copyright 2019 The Go Authors. BSD-3-Clause; see THIRD_PARTY_NOTICES.
//
// Same names and semantics as the Go package, with two changes: indexes are numbers (exact up to
// 2^53, far beyond any tree this log will hold) and tile paths follow C2SP tlog-tiles, which fixes
// the height at 8 and leaves it out of the path. Shifts become divisions by powers of two because
// JavaScript bitwise operators truncate to 32 bits.
import { leafHash, nodeHash } from "@reranker/verify/format";

/** A 32-byte RFC 6962 hash. */
export type Hash = Uint8Array;

/**
 * Returns the hashes stored at the given stored hash indexes, in order. Callers pass the
 * indexes sorted in increasing order.
 */
export type ReadHashes = (indexes: number[]) => Promise<Hash[]>;

/** Tiles are 2^8 = 256 hashes wide, as C2SP tlog-tiles requires. */
export const TILE_HEIGHT = 8;
const TILE_WIDTH = 2 ** TILE_HEIGHT;

export interface Tile {
  height: typeof TILE_HEIGHT;
  level: number;
  n: number;
  width: number;
}

// SHA-256 of the empty string: the RFC 6962 hash of the empty tree.
const EMPTY_TREE_HASH = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

function trailingZeros(x: number): number {
  let zeros = 0;
  for (; x % 2 === 0; x /= 2) zeros++;
  return zeros;
}

/** k, the largest power of two smaller than n, and l = log2(k). */
function maxpow2(n: number): { k: number; l: number } {
  let l = 0;
  while (2 ** (l + 1) < n) l++;
  return { k: 2 ** l, l };
}

async function readExactly(readHashes: ReadHashes, indexes: number[]): Promise<Hash[]> {
  if (indexes.length === 0) return [];
  const hashes = await readHashes(indexes);
  if (hashes.length !== indexes.length) {
    throw new Error(`tlog: ReadHashes(${indexes.length} indexes) = ${hashes.length} hashes`);
  }
  return hashes;
}

/**
 * Maps the tree coordinates (level, n) to the dense linear order of hash storage (Crosby and
 * Wallach, "Efficient Data Structures for Tamper-Evident Logging", §3.3).
 */
export function storedHashIndex(level: number, n: number): number {
  // Level L's n'th hash is written right after level L+1's 2n+1'th hash.
  for (let l = level; l > 0; l--) n = 2 * n + 1;
  // Level 0's n'th hash is written at n + n/2 + n/4 + ...
  let index = 0;
  for (; n > 0; n = Math.floor(n / 2)) index += n;
  return index + level;
}

/** The inverse of {@link storedHashIndex}. */
export function splitStoredHashIndex(index: number): { level: number; n: number } {
  // storedHashIndex(0, n) < 2n, so the record is in [index/2, index/2 + log2(index)].
  let n = Math.floor(index / 2);
  let indexN = storedHashIndex(0, n);
  for (;;) {
    // Each new record n adds 1 + trailingZeros(n + 1) hashes.
    const x = indexN + 1 + trailingZeros(n + 1);
    if (x > index) break;
    n++;
    indexN = x;
  }
  // The hash was committed with record n, so it is one of (0, n), (1, n/2), (2, n/4), ...
  const level = index - indexN;
  return { level, n: Math.floor(n / 2 ** level) };
}

/** The number of stored hashes of a tree with n records. */
export function storedHashCount(n: number): number {
  if (n === 0) return 0;
  // Every hash up to the last leaf, plus those of the subtrees that leaf completes.
  let count = storedHashIndex(0, n - 1) + 1;
  for (let i = n - 1; i % 2 === 1; i = Math.floor(i / 2)) count++;
  return count;
}

/**
 * The hashes to store, starting at storedHashIndex(0, n), when record n with `data` is appended:
 * its leaf hash and the roots of the subtrees it completes. Reads at most log2(n) earlier hashes.
 */
export async function storedHashes(
  n: number,
  data: Uint8Array,
  readHashes: ReadHashes,
): Promise<Hash[]> {
  let hash = leafHash(data);
  const hashes = [hash];
  // Each trailing 1 bit of n completes a subtree and consumes the hash of its left sibling.
  const m = trailingZeros(n + 1);
  const indexes = new Array<number>(m);
  for (let i = 0; i < m; i++) {
    indexes[m - 1 - i] = storedHashIndex(i, Math.floor(n / 2 ** i) - 1);
  }
  const old = await readExactly(readHashes, indexes);
  for (let i = 0; i < m; i++) {
    hash = nodeHash(old[m - 1 - i] as Hash, hash);
    hashes.push(hash);
  }
  return hashes;
}

/** Hands out hashes in the order their indexes were requested. */
type Take = () => Hash;

function taker(hashes: Hash[]): Take {
  let next = 0;
  return () => hashes[next++] as Hash;
}

/** Appends the stored hash indexes that make up the subtree of records [lo, hi). */
function subTreeIndex(lo: number, hi: number, need: number[]): number[] {
  while (lo < hi) {
    const { k, l } = maxpow2(hi - lo + 1);
    need.push(storedHashIndex(l, lo / k));
    lo += k;
  }
  return need;
}

/** Folds the hashes read for subTreeIndex(lo, hi) into the subtree hash. */
function subTreeHash(lo: number, hi: number, take: Take): Hash {
  // A left part of 2^l records whose hash is stored, then the remaining fringe on the right.
  const parts: Hash[] = [];
  while (lo < hi) {
    lo += maxpow2(hi - lo + 1).k;
    parts.push(take());
  }
  let hash = parts.pop() as Hash;
  for (let part = parts.pop(); part !== undefined; part = parts.pop()) hash = nodeHash(part, hash);
  return hash;
}

/** RFC 6962 Merkle Tree Hash of the first n records, from at most 1 + log2(n) stored hashes. */
export async function treeHash(n: number, readHashes: ReadHashes): Promise<Hash> {
  if (n === 0) return new Uint8Array(Buffer.from(EMPTY_TREE_HASH, "hex"));
  const hashes = await readExactly(readHashes, subTreeIndex(0, n, []));
  return subTreeHash(0, n, taker(hashes));
}

/**
 * The roots of the perfect subtrees that make up a tree of n records, left to right: what the
 * next append needs, and what folds into the tree hash. At most 64 hashes.
 */
export async function frontier(n: number, readHashes: ReadHashes): Promise<Hash[]> {
  return readExactly(readHashes, subTreeIndex(0, n, []));
}

// RFC 6962 §2.1.1.
function leafProofIndex(lo: number, hi: number, n: number, need: number[]): number[] {
  if (lo + 1 === hi) return need;
  const { k } = maxpow2(hi - lo);
  if (n < lo + k) {
    leafProofIndex(lo, lo + k, n, need);
    return subTreeIndex(lo + k, hi, need);
  }
  subTreeIndex(lo, lo + k, need);
  return leafProofIndex(lo + k, hi, n, need);
}

function leafProof(lo: number, hi: number, n: number, take: Take): Hash[] {
  // The verifier knows the leaf hash, so the proof stops above it.
  if (lo + 1 === hi) return [];
  // Walk down toward n, recording the hash of the path not taken.
  const { k } = maxpow2(hi - lo);
  if (n < lo + k) {
    const proof = leafProof(lo, lo + k, n, take);
    proof.push(subTreeHash(lo + k, hi, take));
    return proof;
  }
  const sibling = subTreeHash(lo, lo + k, take);
  const proof = leafProof(lo + k, hi, n, take);
  proof.push(sibling);
  return proof;
}

const isSize = (x: number) => Number.isSafeInteger(x) && x >= 0;

/** RFC 6962 inclusion proof ("audit path") of record n in the tree of size t. */
export async function proveRecord(t: number, n: number, readHashes: ReadHashes): Promise<Hash[]> {
  if (!isSize(t) || !isSize(n) || n >= t) {
    throw new RangeError(`tlog: invalid inputs in proveRecord(${t}, ${n})`);
  }
  const hashes = await readExactly(readHashes, leafProofIndex(0, t, n, []));
  return leafProof(0, t, n, taker(hashes));
}

// RFC 6962 §2.1.2.
function treeProofIndex(lo: number, hi: number, n: number, need: number[]): number[] {
  if (n === hi) return lo === 0 ? need : subTreeIndex(lo, hi, need);
  const { k } = maxpow2(hi - lo);
  if (n <= lo + k) {
    treeProofIndex(lo, lo + k, n, need);
    return subTreeIndex(lo + k, hi, need);
  }
  subTreeIndex(lo, lo + k, need);
  return treeProofIndex(lo + k, hi, n, need);
}

function treeProof(lo: number, hi: number, n: number, take: Take): Hash[] {
  // Common ground: the verifier already knows the old tree's hash.
  if (n === hi) return lo === 0 ? [] : [subTreeHash(lo, hi, take)];
  const { k } = maxpow2(hi - lo);
  if (n <= lo + k) {
    const proof = treeProof(lo, lo + k, n, take);
    proof.push(subTreeHash(lo + k, hi, take));
    return proof;
  }
  const sibling = subTreeHash(lo, lo + k, take);
  const proof = treeProof(lo + k, hi, n, take);
  proof.push(sibling);
  return proof;
}

/** RFC 6962 consistency proof that the tree of size t extends the tree of size n. */
export async function proveTree(t: number, n: number, readHashes: ReadHashes): Promise<Hash[]> {
  if (!isSize(t) || !isSize(n) || n < 1 || n > t) {
    throw new RangeError(`tlog: invalid inputs in proveTree(${t}, ${n})`);
  }
  const hashes = await readExactly(readHashes, treeProofIndex(0, t, n, []));
  return treeProof(0, t, n, taker(hashes));
}

/** The tiles to publish when the tree grows from oldTreeSize to newTreeSize records. */
export function newTiles(oldTreeSize: number, newTreeSize: number): Tile[] {
  const tiles: Tile[] = [];
  for (let level = 0; Math.floor(newTreeSize / TILE_WIDTH ** level) > 0; level++) {
    const oldN = Math.floor(oldTreeSize / TILE_WIDTH ** level);
    const newN = Math.floor(newTreeSize / TILE_WIDTH ** level);
    if (oldN === newN) continue;
    const last = Math.floor(newN / TILE_WIDTH);
    for (let n = Math.floor(oldN / TILE_WIDTH); n < last; n++) {
      tiles.push({ height: TILE_HEIGHT, level, n, width: TILE_WIDTH });
    }
    const width = newN - last * TILE_WIDTH;
    if (width > 0) tiles.push({ height: TILE_HEIGHT, level, n: last, width });
  }
  return tiles;
}

// N in zero-padded 3-digit path elements, all but the last prefixed with "x", so no directory
// lists more than 3,000 entries: 1234067 becomes x001/x234/067.
function tileIndexPath(n: number, width: number): string {
  let path = String(n % 1000).padStart(3, "0");
  for (; n >= 1000; ) {
    n = Math.floor(n / 1000);
    path = `x${String(n % 1000).padStart(3, "0")}/${path}`;
  }
  return width === TILE_WIDTH ? path : `${path}.p/${width}`;
}

/** The C2SP tlog-tiles path of a hash tile: tile/<L>/<N>[.p/<W>]. */
export function tilePath(t: Tile): string {
  return `tile/${t.level}/${tileIndexPath(t.n, t.width)}`;
}

/** The C2SP tlog-tiles path of the entry bundle beside level-0 tile n: tile/entries/<N>[.p/<W>]. */
export function entryBundlePath(n: number, width: number): string {
  return `tile/entries/${tileIndexPath(n, width)}`;
}
