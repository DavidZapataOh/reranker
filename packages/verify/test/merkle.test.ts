import { readFileSync } from "node:fs";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { describe, expect, test } from "vitest";
import { leafHash, merkleRoot, nodeHash } from "../src/format/index";
import { rootFromInclusionProof, verifyConsistency, verifyInclusion } from "../src/merkle";
import {
  type ConsistencyCase,
  consistency,
  expectConsistencyMutationsToFail,
  expectInclusionMutationsToFail,
  flipped,
  type InclusionCase,
  inclusion,
  ofTestTree,
  proofs,
} from "./merkle-proofs";
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

// Every size up to 130 runs in merkle.heavy.test.ts, outside coverage; this sample keeps a
// fast check of every stack of up to five pending subtrees in the covered run.
test("matches the recursive RFC 6962 definition for trees up to 33 leaves", () => {
  const entries = sampleEntries(33);
  const expected = referenceRoots(entries);
  for (let n = 1; n <= entries.length; n++) {
    expect(bytesToHex(merkleRoot(entries.slice(0, n))), `${n} leaves`).toBe(expected[n - 1]);
  }
});

// Every fixture's mutations run in merkle.heavy.test.ts, outside coverage; the covered run
// sweeps the RFC 6962 test tree, which has every proof shape of up to eight leaves.
describe("inclusion proofs", () => {
  test.each(proofs.inclusion)("inclusion of $index in $size", (c) =>
    expect(verifyInclusion(inclusion(c))).toBe(true),
  );

  test("the computed root is the tree's root", () => {
    for (const c of proofs.inclusion) {
      const { index, size, leaf, proof } = inclusion(c);
      const root = rootFromInclusionProof(index, size, leaf, proof);
      expect(root && bytesToHex(root), `${index} in ${size}`).toBe(c.root);
    }
  });

  test("an altered proof hash, leaf, root, index or size fails", () => {
    for (const c of proofs.inclusion.filter((c) => ofTestTree(c.size, c.root))) {
      expectInclusionMutationsToFail(c);
    }
  });

  test("index >= size, size 0, unsafe numbers and malformed hashes fail without throwing", () => {
    const p = inclusion(
      proofs.inclusion.find((c) => c.size === 5 && c.index === 2) as InclusionCase,
    );
    for (const [index, size] of [
      [5, 5],
      [6, 5],
      [0, 0],
      [-1, 5],
      [1.5, 5],
      [2, Number.NaN],
      [2, 2 ** 53],
    ] as const) {
      expect(verifyInclusion({ ...p, index, size }), `${index} in ${size}`).toBe(false);
      expect(rootFromInclusionProof(index, size, p.leaf, p.proof)).toBeNull();
    }
    expect(verifyInclusion({ ...p, leaf: p.leaf.slice(1) })).toBe(false);
    const short = [p.proof[0] as Uint8Array, (p.proof[1] as Uint8Array).slice(1)];
    expect(verifyInclusion({ ...p, proof: short })).toBe(false);
    expect(verifyInclusion({ ...p, root: new Uint8Array(0) })).toBe(false);
  });

  test("a proof longer than any tree's height fails", () => {
    const p = inclusion(proofs.inclusion.at(-1) as InclusionCase);
    const proof = Array.from({ length: 1000 }, () => new Uint8Array(32));
    expect(verifyInclusion({ ...p, index: 2 ** 52 - 1, size: 2 ** 52, proof })).toBe(false);
  });
});

describe("consistency proofs", () => {
  test.each(proofs.consistency)("consistency $size1 → $size2", (c) =>
    expect(verifyConsistency(consistency(c))).toBe(true),
  );

  test("an altered proof hash, root or size fails", () => {
    for (const c of proofs.consistency.filter((c) => ofTestTree(c.size2, c.root2))) {
      expectConsistencyMutationsToFail(c);
    }
  });

  test("equal sizes need an empty proof and equal roots", () => {
    const root = hexToBytes((proofs.inclusion[0] as InclusionCase).root);
    const same = { size1: 3, size2: 3, root1: root, root2: root, proof: [] };
    expect(verifyConsistency(same)).toBe(true);
    expect(verifyConsistency({ ...same, root2: flipped(root) })).toBe(false);
    expect(verifyConsistency({ ...same, proof: [root] })).toBe(false);
  });

  test("size 0, a shrinking tree, unsafe numbers and malformed hashes fail without throwing", () => {
    const p = consistency(
      proofs.consistency.find((c) => c.size1 === 3 && c.size2 === 7) as ConsistencyCase,
    );
    for (const [size1, size2] of [
      [0, 7],
      [0, 0],
      [7, 3],
      [-3, 7],
      [3, 7.5],
      [3, Number.POSITIVE_INFINITY],
      [3, 2 ** 53],
    ] as const) {
      expect(verifyConsistency({ ...p, size1, size2 }), `${size1} → ${size2}`).toBe(false);
    }
    expect(verifyConsistency({ ...p, root1: p.root1.slice(1) })).toBe(false);
    expect(verifyConsistency({ ...p, proof: p.proof.map((h) => h.slice(1)) })).toBe(false);
    expect(verifyConsistency({ ...p, proof: [] })).toBe(false);
  });

  test("a proof longer than any tree's height fails", () => {
    const p = consistency(proofs.consistency.at(-1) as ConsistencyCase);
    const proof = Array.from({ length: 1000 }, () => new Uint8Array(32));
    expect(verifyConsistency({ ...p, size1: 3, size2: 2 ** 52, proof })).toBe(false);
  });
});
