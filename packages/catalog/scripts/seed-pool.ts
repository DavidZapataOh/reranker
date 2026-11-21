// What review and freezing both read from a group's candidate pool: which paraphrases ship and
// which reviewed sample stands for them.
import type { ParaphraseFormat } from "@reranker/schema/measurement";
import { rngFromSeed } from "@reranker/stats";
import { sha256Hex } from "../src/hash";

/** Paraphrases kept beside the canonical: 30 per intent in all. */
export const KEEP = 29;
/** At least five of each format per intent, the canonical counting as an open question. */
export const MIN_PER_FORMAT = 5;
export const SAMPLE_PER_INTENT = 3;
export const PERSONAS_PER_CATEGORY = 6;

const FORMATS: readonly ParaphraseFormat[] = [
  "open_question",
  "list_request",
  "keyword",
  "constraint",
];

/**
 * The closest `keep` entries with each format's quota reserved first, in pool order; fewer when
 * the pool cannot meet the quotas, which freezing refuses.
 */
export function planKept<T extends { format: ParaphraseFormat }>(
  pool: readonly T[],
  keep = KEEP,
): T[] {
  const chosen = new Set<T>();
  for (const format of FORMATS) {
    const quota = format === "open_question" ? MIN_PER_FORMAT - 1 : MIN_PER_FORMAT;
    for (const entry of pool.filter((e) => e.format === format).slice(0, quota)) chosen.add(entry);
  }
  for (const entry of pool) {
    if (chosen.size >= keep) break;
    chosen.add(entry);
  }
  return pool.filter((e) => chosen.has(e));
}

/** A fixed draw per intent, so the reviewed sample is the same on every run. */
export function sampleOf<T>(intentId: string, kept: readonly T[], size = SAMPLE_PER_INTENT): T[] {
  const rng = rngFromSeed(sha256Hex(`seed-review:${intentId}`));
  const order = kept.map((entry) => ({ entry, key: rng.next() }));
  return order
    .sort((a, b) => a.key - b.key)
    .slice(0, size)
    .map((o) => o.entry);
}

/** The next pooled entry outside `taken`, of the same format first so quotas hold. */
export function replacementFor<T extends { format: ParaphraseFormat }>(
  pool: readonly T[],
  taken: ReadonlySet<T>,
  format: ParaphraseFormat,
): T | null {
  const free = pool.filter((e) => !taken.has(e));
  return free.find((e) => e.format === format) ?? free[0] ?? null;
}
