import { readFileSync } from "node:fs";
import { merkleRoot } from "@reranker/verify/format";
import { beforeAll, describe, expect, test } from "vitest";
import {
  entryBundlePath,
  frontier,
  type Hash,
  newTiles,
  proveRecord,
  proveTree,
  type ReadHashes,
  splitStoredHashIndex,
  storedHashCount,
  storedHashes,
  storedHashIndex,
  TILE_HEIGHT,
  tilePath,
  treeHash,
} from "../src/log/tlog";

// Written by test/go from golang.org/x/mod/sumdb/tlog; CI regenerates them and fails on any change.
const fixture = <T>(name: string): T[] =>
  JSON.parse(readFileSync(new URL(`./fixtures/tlog/${name}.json`, import.meta.url), "utf8"));

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
const unhex = (value: string) => new Uint8Array(Buffer.from(value, "hex"));

const stored = fixture<{ n: number; data: string; expected: string[] }>("stored-hashes");
const store: Hash[] = [];
const readFrom =
  (hashes: readonly Hash[]): ReadHashes =>
  async (indexes) =>
    indexes.map((index) => hashes[index] as Hash);

// The store is built by this implementation; the stored-hashes vectors check every step of it.
beforeAll(async () => {
  for (const { n, data } of stored)
    store.push(...(await storedHashes(n, unhex(data), readFrom(store))));
});

describe("stored hashes", () => {
  test.each(stored)("stored hashes for record $n match Go", async ({ n, data, expected }) =>
    expect((await storedHashes(n, unhex(data), readFrom(store))).map(hex)).toEqual(expected),
  );

  test("the store holds exactly storedHashCount hashes", () =>
    expect(store).toHaveLength(storedHashCount(stored.length)));

  test("storedHashCount of an empty tree is zero", () => expect(storedHashCount(0)).toBe(0));

  test("splitStoredHashIndex inverts storedHashIndex", () => {
    for (let index = 0; index < 5000; index++) {
      const { level, n } = splitStoredHashIndex(index);
      expect(storedHashIndex(level, n)).toBe(index);
    }
  });

  test("indexes stay exact beyond 32 bits", () => {
    const n = 2 ** 40 + 7;
    expect(splitStoredHashIndex(storedHashIndex(3, n))).toEqual({ level: 3, n });
  });
});

describe("tree hashes", () => {
  const trees = fixture<{ n: number; root: string; frontier: string[] }>("trees");

  test.each(trees)(
    "tree hash and frontier of $n records match Go",
    async ({ n, root, frontier: f }) => {
      expect(hex(await treeHash(n, readFrom(store)))).toBe(root);
      expect((await frontier(n, readFrom(store))).map(hex)).toEqual(f);
    },
  );

  test("tree hash of 1..8 leaves equals merkleRoot", async () => {
    const data = stored.slice(0, 8).map(({ data }) => unhex(data));
    for (let n = 1; n <= 8; n++) {
      expect(hex(await treeHash(n, readFrom(store)))).toBe(hex(merkleRoot(data.slice(0, n))));
    }
  });
});

describe("proofs", () => {
  const prove = (proof: Promise<Hash[]>) =>
    proof.then(
      (hashes) => hashes.map(hex),
      () => null,
    );

  test.each(
    fixture<{ t: number; n: number; record: string[] | null; tree: string[] | null }>("proofs"),
  )("inclusion and consistency for t=$t n=$n match Go", async ({ t, n, record, tree }) => {
    expect(await prove(proveRecord(t, n, readFrom(store)))).toEqual(record);
    expect(await prove(proveTree(t, n, readFrom(store)))).toEqual(tree);
  });
});

describe("tiles", () => {
  const tiles = fixture<{ old: number; new: number; paths: string[]; entries: string[] }>("tiles");

  test.each(tiles)(
    "new tiles from $old to $new match Go paths",
    ({ old, new: next, paths, entries }) => {
      const created = newTiles(old, next);
      expect(created.map(tilePath)).toEqual(paths);
      expect(
        created.filter((t) => t.level === 0).map((t) => entryBundlePath(t.n, t.width)),
      ).toEqual(entries);
    },
  );

  test("tiles are 256 hashes high in C2SP tlog-tiles", () => {
    expect(TILE_HEIGHT).toBe(8);
    expect(newTiles(0, 256)[0]).toEqual({ height: 8, level: 0, n: 0, width: 256 });
  });
});

describe("a reader that returns the wrong number of hashes", () => {
  const short: ReadHashes = async (indexes) => indexes.slice(1).map(() => new Uint8Array(32));

  test.each([
    ["storedHashes", () => storedHashes(1, new Uint8Array(), short)],
    ["treeHash", () => treeHash(3, short)],
    ["proveRecord", () => proveRecord(3, 0, short)],
    ["proveTree", () => proveTree(3, 2, short)],
    ["frontier", () => frontier(3, short)],
  ])("%s rejects it", async (_, call) => await expect(call()).rejects.toThrow(/ReadHashes/));
});
