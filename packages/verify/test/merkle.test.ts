import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { expect, test } from "vitest";
import { leafHash, merkleRoot, nodeHash } from "../src/format/index";

const vectors: {
  leafInputs: string[];
  leafHashes: string[];
  roots: { n: number; root: string }[];
} = JSON.parse(readFileSync(new URL("./fixtures/rfc6962.json", import.meta.url), "utf8"));
const inputs = vectors.leafInputs.map(hexToBytes);

test.each(vectors.leafInputs.map((input, i) => ({ input, hash: vectors.leafHashes[i] })))(
  "leaf hash of '$input' matches transparency-dev/merkle",
  ({ input, hash }) => expect(bytesToHex(leafHash(hexToBytes(input)))).toBe(hash),
);

test("node hash prefixes 0x01 to both children", () => {
  const [a, b] = vectors.leafHashes.map(hexToBytes);
  expect(bytesToHex(nodeHash(a as Uint8Array, b as Uint8Array))).toBe(
    "fac54203e7cc696cf0dfcb42c92a1d9dbaf70ad9e621f4bd8d98662f00e3c125",
  );
});

test.each(vectors.roots)("root of $n leaves matches transparency-dev/merkle", ({ n, root }) =>
  expect(bytesToHex(merkleRoot(inputs.slice(0, n)))).toBe(root),
);

test("empty tree root is SHA-256 of the empty string", () =>
  expect(bytesToHex(merkleRoot([]))).toBe(
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  ));

test("does not mutate its input", () => {
  const leaves = inputs.slice(0, 5);
  const before = leaves.map(bytesToHex);
  merkleRoot(leaves);
  expect(leaves.map(bytesToHex)).toEqual(before);
});

// The recursive MTH definition of RFC 6962 §2.1 over D[start:start+size], hashed with
// node:crypto so it shares no code with the implementation. Memoizing by (start, size) lets each
// prefix reuse the subtrees of shorter ones; recomputing every prefix from scratch made this test
// quadratic in SHA-256 calls.
function referenceRoots(entries: readonly Uint8Array[]): string[] {
  const memo = new Map<string, Buffer>();
  const mth = (start: number, size: number): Buffer => {
    const key = `${start}:${size}`;
    let hash = memo.get(key);
    if (hash === undefined) {
      const sha = createHash("sha256");
      if (size === 1) {
        sha.update(Uint8Array.of(0)).update(entries[start] as Uint8Array);
      } else {
        let k = 1;
        while (k * 2 < size) k *= 2;
        sha
          .update(Uint8Array.of(1))
          .update(mth(start, k))
          .update(mth(start + k, size - k));
      }
      hash = sha.digest();
      memo.set(key, hash);
    }
    return hash;
  };
  return entries.map((_, i) => mth(0, i + 1).toString("hex"));
}

test("the reference definition reproduces transparency-dev/merkle", () =>
  expect(referenceRoots(inputs)).toEqual(
    vectors.roots.filter(({ n }) => n > 0).map((r) => r.root),
  ));

// merkleRoot keeps one pending subtree per set bit of n, so sizes 1..66 reach every combination
// of up to six pending subtrees and cross 64; 126..130 add the seven-subtree stack (127) and the
// crossing into a ninth level. Each size costs 2n - 1 hashes in pure-JS SHA-256, which V8 block
// coverage slows by an order of magnitude, so sizes 67..125 would triple the time without
// reaching a new stack depth or level.
const sizes = [...Array.from({ length: 66 }, (_, i) => i + 1), 126, 127, 128, 129, 130];

test("matches the recursive RFC 6962 definition for 1..66 and 126..130 leaves", () => {
  const entries = Array.from({ length: 130 }, (_, i) => Uint8Array.of(i, i >> 8, 7));
  const expected = referenceRoots(entries);
  for (const n of sizes) {
    expect(bytesToHex(merkleRoot(entries.slice(0, n))), `${n} leaves`).toBe(expected[n - 1]);
  }
});
