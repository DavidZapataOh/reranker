import { createHash } from "node:crypto";
import { expect, test } from "vitest";
import { extendTree, type TreeNode } from "../src/log/frontier";
import { proofHashIndexes, proveFromDatabase, type Read } from "../src/log/proofs";
import {
  type Hash,
  proveRecord,
  proveTree,
  type ReadHashes,
  splitStoredHashIndex,
  storedHashes,
  storedHashIndex,
} from "../src/log/tlog";

// Past 65,536 entries, so proofs cross three tile levels.
const SIZE = 70_000;
const digest = (i: number) => new Uint8Array(createHash("sha256").update(`envelope ${i}`).digest());
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

const entries = Array.from({ length: SIZE }, (_, i) => digest(i));
const store: Hash[] = [];
const fromMemory: ReadHashes = async (indexes) => indexes.map((i) => store[i] as Hash);
for (const [n, entry] of entries.entries()) {
  store.push(...(await storedHashes(n, entry, fromMemory)));
}

// Integration's output, in batches of the sizes a busy minute and a quiet one append.
const nodes: TreeNode[] = [];
let tree = await extendTree(0, [], []);
for (let at = 0; at < SIZE; ) {
  const next = Math.min(SIZE, at + (at % 2 === 0 ? 4_999 : 37));
  tree = await extendTree(tree.size, tree.frontier, entries.slice(at, next));
  nodes.push(...tree.nodes);
  at = next;
}
const nodeRows = new Map(nodes.map((node) => [node.index, node.hash]));

// Postgres as the proof statement sees it: every entry and every stored large-subtree hash.
function database(withNode: (index: number) => boolean = () => true): Read {
  return (async () => [
    ...entries.map((hash, i) => ({ source: "entry", key: String(i), hash: Buffer.from(hash) })),
    ...[...nodeRows]
      .filter(([index]) => withNode(index))
      .map(([index, hash]) => ({ source: "node", key: String(index), hash: Buffer.from(hash) })),
  ]) as Read;
}

test("integration stores the hash of every subtree of 256 entries and more, once", () => {
  expect(nodes).toHaveLength(nodeRows.size);
  for (const node of nodes) {
    expect(splitStoredHashIndex(node.index).level).toBeGreaterThanOrEqual(8);
    expect(hex(node.hash)).toBe(hex(store[node.index] as Hash));
  }
  expect(nodeRows.has(storedHashIndex(16, 0))).toBe(true);
});

test.each([
  [256, 0, 256],
  [1_000, 999, 1_300],
  [65_636, 40_097, 65_936],
  [65_636, 65_635, 70_000],
  [69_999, 12_345, 69_999],
])("proofs from Postgres equal the tiles' for record %#", async (treeSize, index, latest) => {
  const proofs = await proveFromDatabase("log.test/x", treeSize, index, latest, database());
  expect(proofs.inclusion.map(hex)).toEqual(
    (await proveRecord(treeSize, index, fromMemory)).map(hex),
  );
  expect(proofs.consistency.map(hex)).toEqual(
    (await proveTree(latest, treeSize, fromMemory)).map(hex),
  );
});

test("a missing tree hash or entry fails instead of proving against the wrong tree", async () => {
  const [large] = (await proofHashIndexes(65_636, 40_097, 65_936)).filter(
    (i) => splitStoredHashIndex(i).level >= 8,
  );
  await expect(
    proveFromDatabase(
      "log.test/x",
      65_636,
      40_097,
      65_936,
      database((i) => i !== large),
    ),
  ).rejects.toThrow(/not in Postgres/);
  const all = database();
  const noEntries = (async (query) =>
    (await all(query)).filter((row) => row.source === "node")) as Read;
  await expect(proveFromDatabase("log.test/x", 1_000, 999, 1_300, noEntries)).rejects.toThrow(
    /not all in Postgres/,
  );
});
