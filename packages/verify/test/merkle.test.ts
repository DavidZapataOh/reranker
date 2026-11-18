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

// The recursive MTH definition of RFC 6962 §2.1, as written there.
function referenceRoot(entries: readonly Uint8Array[]): Uint8Array {
  if (entries.length === 1) return leafHash(entries[0] as Uint8Array);
  let k = 1;
  while (k * 2 < entries.length) k *= 2;
  return nodeHash(referenceRoot(entries.slice(0, k)), referenceRoot(entries.slice(k)));
}

test("matches the recursive RFC 6962 definition for trees up to 130 leaves", () => {
  const entries = Array.from({ length: 130 }, (_, i) => Uint8Array.of(i, i >> 8, 7));
  for (let n = 1; n <= entries.length; n++) {
    expect(bytesToHex(merkleRoot(entries.slice(0, n)))).toBe(
      bytesToHex(referenceRoot(entries.slice(0, n))),
    );
  }
});
