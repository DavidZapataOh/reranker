import {
  frontier as frontierOf,
  type Hash,
  type ReadHashes,
  storedHashes,
  storedHashIndex,
  treeHash,
} from "./tlog";

const setBits = (n: number) => n.toString(2).replaceAll("0", "").length;

/**
 * Appends `entries` to the tree of `size` records whose frontier (the roots of its perfect
 * subtrees, left to right) is `frontier`, and returns the new root and frontier. Every hash an
 * append reads is either a frontier root or one computed in this call, so no tile is read.
 */
export async function extendTree(
  size: number,
  frontier: Hash[],
  entries: Uint8Array[],
): Promise<{ size: number; root: Hash; frontier: Hash[] }> {
  if (frontier.length !== setBits(size)) {
    throw new Error(`A frontier of ${frontier.length} hashes cannot belong to a tree of ${size}`);
  }
  const stored = new Map<number, Hash>();
  // frontier() requests exactly the stored indexes of those roots, in order.
  await frontierOf(size, async (indexes) => {
    for (const [i, index] of indexes.entries()) stored.set(index, frontier[i] as Hash);
    return frontier;
  });
  const read: ReadHashes = async (indexes) =>
    indexes.map((index) => {
      const hash = stored.get(index);
      if (!hash) throw new Error(`Stored hash ${index} is outside the frontier of ${size}`);
      return hash;
    });
  for (const [i, entry] of entries.entries()) {
    const n = size + i;
    const first = storedHashIndex(0, n);
    const hashes = await storedHashes(n, entry, read);
    for (const [j, hash] of hashes.entries()) stored.set(first + j, hash);
  }
  const newSize = size + entries.length;
  return {
    size: newSize,
    root: await treeHash(newSize, read),
    frontier: await frontierOf(newSize, read),
  };
}
