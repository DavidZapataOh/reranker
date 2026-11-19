import { bytesToHex } from "@noble/hashes/utils.js";
import { expect, test } from "vitest";
import { merkleRoot } from "../src/format/index";
import {
  expectConsistencyMutationsToFail,
  expectInclusionMutationsToFail,
  proofs,
} from "./merkle-proofs";
import { referenceRoots, sampleEntries } from "./rfc6962-reference";

// 130 crosses 128, so every stack of up to seven pending subtrees and a ninth level are reached.
test("matches the recursive RFC 6962 definition for every tree up to 130 leaves", () => {
  const entries = sampleEntries(130);
  const expected = referenceRoots(entries);
  for (let n = 1; n <= entries.length; n++) {
    expect(bytesToHex(merkleRoot(entries.slice(0, n))), `${n} leaves`).toBe(expected[n - 1]);
  }
});

test("every inclusion fixture fails once a proof hash, leaf, root, index or size changes", () => {
  for (const c of proofs.inclusion) expectInclusionMutationsToFail(c);
});

test("every consistency fixture fails once a proof hash, root or size changes", () => {
  for (const c of proofs.consistency) expectConsistencyMutationsToFail(c);
});
