import { readFileSync } from "node:fs";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { describe, expect, test } from "vitest";
import { leafHash, merkleRoot, nodeHash } from "../src/format/index";
import { rootFromInclusionProof, verifyConsistency, verifyInclusion } from "../src/merkle";
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

type InclusionCase = { index: number; size: number; leaf: string; proof: string[]; root: string };
type ConsistencyCase = {
  size1: number;
  size2: number;
  root1: string;
  root2: string;
  proof: string[];
};

// Written by test/go from golang.org/x/mod/sumdb/tlog and transparency-dev/merkle's testonly
// tree, and checked there with transparency-dev/merkle/proof.
const proofs: { inclusion: InclusionCase[]; consistency: ConsistencyCase[] } = JSON.parse(
  readFileSync(new URL("./fixtures/proofs.json", import.meta.url), "utf8"),
);

const inclusion = (c: InclusionCase) => ({
  index: c.index,
  size: c.size,
  leaf: hexToBytes(c.leaf),
  proof: c.proof.map(hexToBytes),
  root: hexToBytes(c.root),
});

const consistency = (c: ConsistencyCase) => ({
  size1: c.size1,
  size2: c.size2,
  root1: hexToBytes(c.root1),
  root2: hexToBytes(c.root2),
  proof: c.proof.map(hexToBytes),
});

const flipped = (hash: Uint8Array) => hash.map((byte, i) => (i === 0 ? byte ^ 1 : byte));

// The two trees the fixtures prove, rebuilt one entry past their end so a size can grow by one.
const trees = [
  inputs,
  Array.from({ length: 1101 }, (_, n) => new TextEncoder().encode(`reranker tlog record ${n}`)),
].map((entries) => ({ entries, roots: referenceRoots(entries) }));

/**
 * A root does not commit to its tree's size: a proof can hold for another size with the same
 * root, which is why the size comes from a signed checkpoint. So a changed size is checked
 * against that size's real root, the only way a tampered size could be passed off.
 */
function resized(size: number, root: string, newSize: number): Uint8Array | null {
  const tree = trees.find(({ roots }) => roots[size - 1] === root);
  if (tree === undefined) throw new Error(`no fixture tree has root ${root} at size ${size}`);
  const newRoot = tree.roots[newSize - 1];
  return newRoot === undefined ? null : hexToBytes(newRoot);
}

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
    for (const c of proofs.inclusion) {
      const p = inclusion(c);
      const label = `${c.index} in ${c.size}`;
      p.proof.forEach((_, i) => {
        const proof = p.proof.map((hash, j) => (i === j ? flipped(hash) : hash));
        expect(verifyInclusion({ ...p, proof }), `${label}, hash ${i}`).toBe(false);
      });
      expect(verifyInclusion({ ...p, leaf: flipped(p.leaf) }), label).toBe(false);
      expect(verifyInclusion({ ...p, root: flipped(p.root) }), label).toBe(false);
      expect(verifyInclusion({ ...p, proof: [...p.proof, p.root] }), label).toBe(false);
      if (p.proof.length > 0) {
        expect(verifyInclusion({ ...p, proof: p.proof.slice(1) }), label).toBe(false);
      }
      for (const index of [p.index - 1, p.index + 1].filter((i) => i >= 0 && i < p.size)) {
        expect(verifyInclusion({ ...p, index }), `${label} as index ${index}`).toBe(false);
      }
      for (const size of [p.size - 1, p.size + 1].filter((s) => s > p.index)) {
        const root = resized(c.size, c.root, size);
        if (root === null) continue;
        expect(verifyInclusion({ ...p, size, root }), `${label} as size ${size}`).toBe(false);
      }
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
    for (const c of proofs.consistency) {
      const p = consistency(c);
      const label = `${c.size1} → ${c.size2}`;
      p.proof.forEach((_, i) => {
        const proof = p.proof.map((hash, j) => (i === j ? flipped(hash) : hash));
        expect(verifyConsistency({ ...p, proof }), `${label}, hash ${i}`).toBe(false);
      });
      expect(verifyConsistency({ ...p, root1: flipped(p.root1) }), label).toBe(false);
      expect(verifyConsistency({ ...p, root2: flipped(p.root2) }), label).toBe(false);
      expect(verifyConsistency({ ...p, proof: [...p.proof, p.root2] }), label).toBe(false);
      if (p.proof.length > 0) {
        expect(verifyConsistency({ ...p, proof: p.proof.slice(1) }), label).toBe(false);
      }
      for (const size1 of [p.size1 - 1, p.size1 + 1].filter((s) => s > 0 && s <= p.size2)) {
        const root1 = resized(c.size1, c.root1, size1) as Uint8Array;
        expect(verifyConsistency({ ...p, size1, root1 }), `${label} from ${size1}`).toBe(false);
      }
      for (const size2 of [p.size2 - 1, p.size2 + 1].filter((s) => s >= p.size1)) {
        const root2 = resized(c.size2, c.root2, size2);
        if (root2 === null) continue;
        expect(verifyConsistency({ ...p, size2, root2 }), `${label} to ${size2}`).toBe(false);
      }
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
