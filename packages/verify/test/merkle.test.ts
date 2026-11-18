import { readFileSync } from "node:fs";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { expect, test } from "vitest";
import { leafHash, merkleRoot, nodeHash } from "../src/format/index";
import { referenceRoots, sampleEntries } from "./rfc6962-reference";

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

test("the reference definition reproduces transparency-dev/merkle", () =>
  expect(referenceRoots(inputs)).toEqual(
    vectors.roots.filter(({ n }) => n > 0).map((r) => r.root),
  ));

// Every size up to 130 runs in merkle.exhaustive.test.ts, outside coverage; this sample keeps a
// fast check of every stack of up to five pending subtrees in the covered run.
test("matches the recursive RFC 6962 definition for trees up to 33 leaves", () => {
  const entries = sampleEntries(33);
  const expected = referenceRoots(entries);
  for (let n = 1; n <= entries.length; n++) {
    expect(bytesToHex(merkleRoot(entries.slice(0, n))), `${n} leaves`).toBe(expected[n - 1]);
  }
});
