import type { ParaphraseFormat } from "@reranker/schema/measurement";
import {
  type CategoryPool,
  type GroupPool,
  groupIntents,
  namesFor,
  type PoolEntry,
} from "../../scripts/build-seed";
import { seedCategories } from "../../src/categories";

export const FORMATS: ParaphraseFormat[] = [
  "open_question",
  "list_request",
  "keyword",
  "constraint",
];
export const entry = (text: string, format: ParaphraseFormat): PoolEntry => ({
  text,
  format,
  generator: "openai",
  closeness: 0.8,
});
// Mostly keywords up front, so the quotas have to reach down the pool.
export const pool = (n: number, prefix = "p") =>
  Array.from({ length: n }, (_, i) =>
    entry(`${prefix}${i}`, i < 30 ? "keyword" : (FORMATS[i % 4] ?? "keyword")),
  );

export function categoryPool(
  key: string,
  language: "es" | "fr",
  profile: "co" | "neutral",
): CategoryPool {
  const category = seedCategories().find((c) => c.key === key);
  if (!category) throw new Error(key);
  const { noun, synonyms } = namesFor(category, language);
  return {
    key,
    noun,
    synonyms,
    intents: groupIntents(category, { language, registerProfile: profile }).map((plan) => ({
      ...plan,
      pool: pool(40, `${plan.intentId}:`),
      candidates: pool(40, `${plan.intentId}:`).map((p) => ({ ...p, judged: true })),
      report: {
        candidates: 50,
        guards: {
          placeholder: 0,
          category_noun: 0,
          proper_name: 0,
          qualifier: 0,
          length: 0,
          personal_data: 0,
        },
        dedupe: 0,
        offCentroid: 0,
        judge: 0,
        rounds: 1,
        maxPairCosine: 0.8,
        canonicalCloseness: 0.9,
        canonicalRank: 1,
      },
    })),
    personas: Array.from({ length: 9 }, (_, i) => ({ text: `persona ${i}`, generator: "gemini" })),
  };
}

export const groupPool = (language: "es" | "fr", profile: "co" | "neutral"): GroupPool => ({
  version: "2026.11.0",
  language,
  registerProfile: profile,
  generatorConfigHash: "0".repeat(64),
  builtAt: "2026-11-21T00:00:00.000Z",
  costMicros: 0,
  categories: seedCategories().map((c) => categoryPool(c.key, language, profile)),
});
