import { readFileSync } from "node:fs";
import { hexToBytes } from "@noble/hashes/utils.js";
import { expect } from "vitest";
import { verifyConsistency, verifyInclusion } from "../src/merkle";
import { referenceRoots } from "./rfc6962-reference";

export type InclusionCase = {
  index: number;
  size: number;
  leaf: string;
  proof: string[];
  root: string;
};
export type ConsistencyCase = {
  size1: number;
  size2: number;
  root1: string;
  root2: string;
  proof: string[];
};

// Written by test/go from golang.org/x/mod/sumdb/tlog and transparency-dev/merkle's testonly
// tree, and checked there with transparency-dev/merkle/proof.
export const proofs: { inclusion: InclusionCase[]; consistency: ConsistencyCase[] } = JSON.parse(
  readFileSync(new URL("./fixtures/proofs.json", import.meta.url), "utf8"),
);

const rfc6962: { leafInputs: string[] } = JSON.parse(
  readFileSync(new URL("./fixtures/rfc6962.json", import.meta.url), "utf8"),
);

// The two trees the fixtures prove, rebuilt one entry past their end so a size can grow by one.
const [testTree, tlogTree] = [
  rfc6962.leafInputs.map(hexToBytes),
  Array.from({ length: 1101 }, (_, n) => new TextEncoder().encode(`reranker tlog record ${n}`)),
].map((entries) => referenceRoots(entries)) as [string[], string[]];

/** Whether a proof is of the eight-leaf RFC 6962 test tree: a sample small enough to sweep. */
export const ofTestTree = (size: number, root: string) => testTree[size - 1] === root;

export const inclusion = (c: InclusionCase) => ({
  index: c.index,
  size: c.size,
  leaf: hexToBytes(c.leaf),
  proof: c.proof.map(hexToBytes),
  root: hexToBytes(c.root),
});

export const consistency = (c: ConsistencyCase) => ({
  size1: c.size1,
  size2: c.size2,
  root1: hexToBytes(c.root1),
  root2: hexToBytes(c.root2),
  proof: c.proof.map(hexToBytes),
});

export const flipped = (hash: Uint8Array) => hash.map((byte, i) => (i === 0 ? byte ^ 1 : byte));

/**
 * A root does not commit to its tree's size: a proof can hold for another size with the same
 * root, which is why the size comes from a signed checkpoint. So a changed size is checked
 * against that size's real root, the only way a tampered size could be passed off.
 */
function resized(size: number, root: string, newSize: number): Uint8Array | null {
  const roots = ofTestTree(size, root) ? testTree : tlogTree;
  if (roots[size - 1] !== root) throw new Error(`no fixture tree has root ${root} at size ${size}`);
  const newRoot = roots[newSize - 1];
  return newRoot === undefined ? null : hexToBytes(newRoot);
}

export function expectInclusionMutationsToFail(c: InclusionCase): void {
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

export function expectConsistencyMutationsToFail(c: ConsistencyCase): void {
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
