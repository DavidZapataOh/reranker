import { createHash } from "node:crypto";

/**
 * Roots of every prefix of `entries` by the recursive MTH definition of RFC 6962 §2.1 over
 * D[start:start+size]. Hashed with node:crypto so it shares no code with the implementation;
 * memoized by (start, size) so each prefix reuses the subtrees of shorter ones instead of
 * rehashing them, which would make checking every prefix quadratic.
 */
export function referenceRoots(entries: readonly Uint8Array[]): string[] {
  const memo = new Map<string, Buffer>();
  const mth = (start: number, size: number): Buffer => {
    const key = `${start}:${size}`;
    let hash = memo.get(key);
    if (hash === undefined) {
      const sha = createHash("sha256");
      if (size === 1) {
        sha.update(Uint8Array.of(0)).update(entries[start] as Uint8Array);
      } else {
        let k = 1;
        while (k * 2 < size) k *= 2;
        sha
          .update(Uint8Array.of(1))
          .update(mth(start, k))
          .update(mth(start + k, size - k));
      }
      hash = sha.digest();
      memo.set(key, hash);
    }
    return hash;
  };
  return entries.map((_, i) => mth(0, i + 1).toString("hex"));
}

/** Distinct, deterministic entries whose two-byte index keeps them unique past 255 leaves. */
export const sampleEntries = (count: number): Uint8Array[] =>
  Array.from({ length: count }, (_, i) => Uint8Array.of(i, i >> 8, 7));
