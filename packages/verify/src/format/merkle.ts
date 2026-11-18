import { sha256 } from "@noble/hashes/sha2.js";

/** RFC 6962 §2.1 leaf hash: SHA-256(0x00 ‖ entry). */
export function leafHash(entry: Uint8Array): Uint8Array {
  const input = new Uint8Array(1 + entry.length);
  input.set(entry, 1);
  return sha256(input);
}

/** RFC 6962 §2.1 interior node hash: SHA-256(0x01 ‖ left ‖ right). */
export function nodeHash(left: Uint8Array, right: Uint8Array): Uint8Array {
  const input = new Uint8Array(1 + left.length + right.length);
  input[0] = 1;
  input.set(left, 1);
  input.set(right, 1 + left.length);
  return sha256(input);
}

interface Subtree {
  hash: Uint8Array;
  size: number;
}

/** RFC 6962 §2.1 Merkle Tree Hash of the entries; the empty tree hashes to SHA-256(""). */
export function merkleRoot(leaves: readonly Uint8Array[]): Uint8Array {
  if (leaves.length === 0) return sha256(new Uint8Array(0));
  // Merging equal-sized perfect subtrees left to right, then folding the rest from the right,
  // builds the same tree as splitting at the largest power of two below n, without recursion.
  const stack: Subtree[] = [];
  for (const leaf of leaves) {
    let node: Subtree = { hash: leafHash(leaf), size: 1 };
    let top = stack.at(-1);
    while (top !== undefined && top.size === node.size) {
      stack.pop();
      node = { hash: nodeHash(top.hash, node.hash), size: node.size * 2 };
      top = stack.at(-1);
    }
    stack.push(node);
  }
  let root = (stack.pop() as Subtree).hash;
  for (let top = stack.pop(); top !== undefined; top = stack.pop()) {
    root = nodeHash(top.hash, root);
  }
  return root;
}
