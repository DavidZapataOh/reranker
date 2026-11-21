import type { ParaphraseFormat } from "@reranker/schema/measurement";
import { describe, expect, test, vi } from "vitest";
import {
  type CategoryPool,
  type GroupPool,
  groupIntents,
  namesFor,
  type PoolEntry,
} from "../scripts/build-seed";
import { reviewCategory } from "../scripts/review-native";
import { reviewItems } from "../scripts/review-sample";
import { intentFit, KEEP, planKept, replacementFor, sampleOf } from "../scripts/seed-pool";
import { seedCategories } from "../src/categories";
import type { ReviewRequest } from "../src/generate/providers";

const FORMATS: ParaphraseFormat[] = ["open_question", "list_request", "keyword", "constraint"];
const entry = (text: string, format: ParaphraseFormat): PoolEntry => ({
  text,
  format,
  generator: "openai",
  closeness: 0.8,
});
// Mostly keywords up front, so the quotas have to reach down the pool.
const pool = (n: number, prefix = "p") =>
  Array.from({ length: n }, (_, i) =>
    entry(`${prefix}${i}`, i < 30 ? "keyword" : (FORMATS[i % 4] ?? "keyword")),
  );

describe("which paraphrases ship", () => {
  test("29 closest with five of each format, the canonical standing for one open question", () => {
    const kept = planKept(pool(60));
    expect(kept).toHaveLength(KEEP);
    const count = (f: ParaphraseFormat) => kept.filter((e) => e.format === f).length;
    expect(count("open_question")).toBeGreaterThanOrEqual(4);
    for (const f of ["list_request", "keyword", "constraint"] as const) {
      expect(count(f)).toBeGreaterThanOrEqual(5);
    }
  });

  test("the sample is fixed per intent and drawn from what ships", () => {
    const kept = planKept(pool(60));
    const a = sampleOf("hotel.es-co-discovery", kept);
    expect(a).toHaveLength(3);
    expect(sampleOf("hotel.es-co-discovery", kept)).toEqual(a);
    expect(a.every((e) => kept.includes(e))).toBe(true);
    expect(sampleOf("hotel.es-co-zone", kept)).not.toEqual(a);
  });

  test("a replacement keeps the format when the pool has one left", () => {
    const all = pool(60);
    const kept = new Set(planKept(all));
    expect(replacementFor(all, kept, "constraint")?.format).toBe("constraint");
    expect(replacementFor(all.slice(0, 2), new Set(all.slice(0, 2)), "keyword")).toBeNull();
  });
});

function categoryPool(key: string, language: "es" | "fr", profile: "co" | "neutral"): CategoryPool {
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

const groupPool = (language: "es" | "fr", profile: "co" | "neutral"): GroupPool => ({
  version: "2026.11.0",
  language,
  registerProfile: profile,
  generatorConfigHash: "0".repeat(64),
  builtAt: "2026-11-21T00:00:00.000Z",
  costMicros: 0,
  categories: seedCategories().map((c) => categoryPool(c.key, language, profile)),
});

describe("short intents", () => {
  const of = (counts: Partial<Record<ParaphraseFormat, number>>) =>
    FORMATS.flatMap((f) => Array.from({ length: counts[f] ?? 0 }, (_, i) => entry(`${f}${i}`, f)));

  test("29 with the quotas ship in full", () =>
    expect(intentFit(of({ open_question: 8, list_request: 7, keyword: 7, constraint: 7 }))).toBe(
      "full",
    ));

  test("fewer ship when every format has two and the sampler gets seven draws", () => {
    expect(intentFit(of({ open_question: 2, list_request: 2, keyword: 4, constraint: 2 }))).toBe(
      "short",
    );
    // The canonical is the second open question.
    expect(intentFit(of({ open_question: 1, list_request: 2, keyword: 2, constraint: 2 }))).toBe(
      "short",
    );
  });

  test("a format with one paraphrase or fewer than seven in all drops the intent", () => {
    expect(intentFit(of({ open_question: 10, list_request: 10, keyword: 1, constraint: 10 }))).toBe(
      "drop",
    );
    expect(intentFit(of({ open_question: 1, list_request: 2, keyword: 2, constraint: 1 }))).toBe(
      "drop",
    );
  });
});

describe("native review", () => {
  const spend = { purpose: "benchmark" as const, refType: "test", refId: "t" };

  test("an item passes only when both reviewers keep it; a missing verdict never passes", async () => {
    const review = vi.fn(async (provider: "openai" | "gemini", req: ReviewRequest) =>
      req.items.map((_, i) => {
        if (provider === "gemini" && i === 1)
          return { keep: false, reasons: ["register" as const] };
        if (provider === "gemini" && i === 2) return null;
        return { keep: true, reasons: [] };
      }),
    );
    const group = { language: "fr", registerProfile: "neutral" } as const;
    const result = await reviewCategory(
      group,
      categoryPool("hotel", "fr", "neutral"),
      spend,
      review,
    );

    // One call for canonicals and personas, one per intent, each by both reviewers.
    expect(review).toHaveBeenCalledTimes(2 * 9);
    expect(result.canonicals).toHaveLength(8);
    expect(result.personas).toHaveLength(9);
    expect(result.intents[0]?.paraphrases).toHaveLength(40);
    expect(result.canonicals.map((c) => c.pass).slice(0, 3)).toEqual([true, false, false]);
    expect(result.canonicals[1]?.verdicts.gemini).toEqual({ keep: false, reasons: ["register"] });
    expect(result.canonicals[2]?.verdicts.gemini).toBeNull();
    expect(result.canonicals[0]?.text).not.toContain("{sustantivo}");
  });

  test("a reviewer that fails leaves every item without its verdict, so nothing passes", async () => {
    const review = vi.fn(async (provider: "openai" | "gemini", req: ReviewRequest) => {
      if (provider === "openai") throw new Error("down");
      return req.items.map(() => ({ keep: true, reasons: [] }));
    });
    const group = { language: "fr", registerProfile: "neutral" } as const;
    const result = await reviewCategory(
      group,
      categoryPool("hotel", "fr", "neutral"),
      spend,
      review,
    );
    expect(result.personas.every((p) => !p.pass && p.verdicts.openai === null)).toBe(true);
  });
});

describe("the Spanish review", () => {
  const items = reviewItems([groupPool("es", "co"), groupPool("es", "neutral")]);
  const of = (kind: string) => items.filter((i) => i.kind === kind);

  test("only what ships: shared canonicals once, six personas per category, three samples per intent", () => {
    // Both profiles share every canonical but one ("arrendar" against "alquilar").
    expect(of("canonical")).toHaveLength(6 * 8 + 1);
    expect(of("persona")).toHaveLength(2 * 6 * 6);
    expect(of("paraphrase")).toHaveLength(2 * 6 * 8 * 3);
    expect(new Set(items.map((i) => i.id)).size).toBe(items.length);
  });

  test("reserves come along only to stand in for a rejection", () => {
    const persona = of("persona")[0];
    expect(persona?.kind === "persona" && persona.reserves).toEqual([
      "persona 6",
      "persona 7",
      "persona 8",
    ]);
    const paraphrase = of("paraphrase")[0];
    if (paraphrase?.kind !== "paraphrase") throw new Error("no paraphrase");
    expect(paraphrase.reserves).toHaveLength(3);
    expect(paraphrase.reserves).not.toContain(paraphrase.text);
    expect(paraphrase.category).toBe("Clínica odontológica");
  });
});
