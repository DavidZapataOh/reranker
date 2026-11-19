import { nodeHash } from "./format/index";

const HASH_BYTES = 32;
// No tree with a safe-integer size is this many levels high, so a longer proof is rejected
// before any hashing.
const MAX_PROOF_HASHES = 64;

const isCount = (n: number) => Number.isSafeInteger(n) && n >= 0;
const isHash = (hash: Uint8Array) => hash.length === HASH_BYTES;
const isProof = (proof: readonly Uint8Array[]) =>
  proof.length <= MAX_PROOF_HASHES && proof.every(isHash);

// Sizes may exceed 2^32, where JavaScript's bitwise operators truncate, so bits are read with
// arithmetic, which is exact for safe integers.
const odd = (n: number) => n % 2 === 1;
const half = (n: number) => Math.floor(n / 2);

function isPowerOfTwo(n: number): boolean {
  let m = n;
  while (m > 1 && !odd(m)) m = half(m);
  return m === 1;
}

function equal(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

/**
 * Root implied by an inclusion proof for the leaf hash at `index` in a tree of `size` leaves,
 * following RFC 9162 §2.1.3.2; null when the proof cannot belong to that position.
 */
export function rootFromInclusionProof(
  index: number,
  size: number,
  leaf: Uint8Array,
  proof: readonly Uint8Array[],
): Uint8Array | null {
  if (!isCount(index) || !isCount(size) || index >= size) return null;
  if (!isHash(leaf) || !isProof(proof)) return null;

  let fn = index;
  let sn = size - 1;
  let r = leaf;
  for (const p of proof) {
    if (sn === 0) return null;
    if (odd(fn) || fn === sn) {
      r = nodeHash(p, r);
      while (!odd(fn) && fn !== 0) {
        fn = half(fn);
        sn = half(sn);
      }
    } else {
      r = nodeHash(r, p);
    }
    fn = half(fn);
    sn = half(sn);
  }
  return sn === 0 ? r : null;
}

/** RFC 9162 §2.1.3.2: the leaf hash sits at `index` in the tree of `size` leaves with `root`. */
export function verifyInclusion(p: {
  index: number;
  size: number;
  leaf: Uint8Array;
  proof: readonly Uint8Array[];
  root: Uint8Array;
}): boolean {
  const root = rootFromInclusionProof(p.index, p.size, p.leaf, p.proof);
  return root !== null && equal(root, p.root);
}

/**
 * RFC 9162 §2.1.4.2: the tree of `size2` leaves with `root2` extends the one of `size1` with
 * `root1`. Equal sizes take the empty proof of §2.1.4.1 and must have the same root; a tree is
 * never proven against the empty one, which no checkpoint of a log with entries has.
 */
export function verifyConsistency(p: {
  size1: number;
  size2: number;
  root1: Uint8Array;
  root2: Uint8Array;
  proof: readonly Uint8Array[];
}): boolean {
  const { size1, size2, root1, root2, proof } = p;
  if (!isCount(size1) || !isCount(size2) || size1 === 0 || size1 > size2) return false;
  if (!isHash(root1) || !isHash(root2) || !isProof(proof)) return false;
  if (size1 === size2) return proof.length === 0 && equal(root1, root2);
  if (proof.length === 0) return false;

  const path = isPowerOfTwo(size1) ? [root1, ...proof] : proof;
  let fn = size1 - 1;
  let sn = size2 - 1;
  while (odd(fn)) {
    fn = half(fn);
    sn = half(sn);
  }
  let fr = path[0] as Uint8Array;
  let sr = fr;
  for (const c of path.slice(1)) {
    if (sn === 0) return false;
    if (odd(fn) || fn === sn) {
      fr = nodeHash(c, fr);
      sr = nodeHash(c, sr);
      while (!odd(fn) && fn !== 0) {
        fn = half(fn);
        sn = half(sn);
      }
    } else {
      sr = nodeHash(sr, c);
    }
    fn = half(fn);
    sn = half(sn);
  }
  return sn === 0 && equal(fr, root1) && equal(sr, root2);
}
