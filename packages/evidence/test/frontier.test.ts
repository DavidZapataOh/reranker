import { createHash } from "node:crypto";
import { merkleRoot } from "@reranker/verify/format";
import { describe, expect, test } from "vitest";
import { extendTree } from "../src/log/frontier";

const digest = (i: number) => new Uint8Array(createHash("sha256").update(`envelope ${i}`).digest());
const leaves = (from: number, to: number) =>
  Array.from({ length: to - from }, (_, i) => digest(from + i));
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
const popcount = (n: number) => n.toString(2).replaceAll("0", "").length;

describe("extendTree", () => {
  test.each([1, 2, 3, 7, 8, 255, 256, 257, 1000])(
    "an empty tree grown by %i leaves has their RFC 6962 root",
    async (n) => {
      const tree = await extendTree(0, [], leaves(0, n));
      expect(tree.size).toBe(n);
      expect(hex(tree.root)).toBe(hex(merkleRoot(leaves(0, n))));
      expect(tree.frontier).toHaveLength(popcount(n));
    },
  );

  test.each([
    [1, 1],
    [3, 5],
    [8, 8],
    [255, 2],
    [256, 1],
    [300, 700],
    [511, 513],
  ])("a batch of %i then one of %i equals one batch of both", async (first, second) => {
    const a = await extendTree(0, [], leaves(0, first));
    const b = await extendTree(a.size, a.frontier, leaves(first, first + second));
    const whole = await extendTree(0, [], leaves(0, first + second));
    expect(b.size).toBe(first + second);
    expect(hex(b.root)).toBe(hex(whole.root));
    expect(b.frontier.map(hex)).toEqual(whole.frontier.map(hex));
  });

  test("many small batches reach the root of one large one", async () => {
    let tree = await extendTree(0, [], []);
    for (let size = 0; size < 600; size += 37) {
      tree = await extendTree(tree.size, tree.frontier, leaves(size, Math.min(size + 37, 600)));
    }
    expect(hex(tree.root)).toBe(hex(merkleRoot(leaves(0, 600))));
  });

  test("rejects a frontier that does not match the tree size", async () => {
    const tree = await extendTree(0, [], leaves(0, 6));
    await expect(extendTree(4, tree.frontier, leaves(6, 7))).rejects.toThrow(/frontier/);
    await expect(extendTree(0, tree.frontier, leaves(6, 7))).rejects.toThrow(/frontier/);
  });
});
