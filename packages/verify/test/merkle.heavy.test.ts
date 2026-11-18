import { bytesToHex } from "@noble/hashes/utils.js";
import { expect, test } from "vitest";
import { merkleRoot } from "../src/format/index";
import { referenceRoots, sampleEntries } from "./rfc6962-reference";

// 130 crosses 128, so every stack of up to seven pending subtrees and a ninth level are reached.
test("matches the recursive RFC 6962 definition for every tree up to 130 leaves", () => {
  const entries = sampleEntries(130);
  const expected = referenceRoots(entries);
  for (let n = 1; n <= entries.length; n++) {
    expect(bytesToHex(merkleRoot(entries.slice(0, n))), `${n} leaves`).toBe(expected[n - 1]);
  }
});
