import type { EngineId } from "@reranker/schema";
import { describe, expect, test } from "vitest";
import { buildObservations, type ObservationFrame } from "../src/observations";
import { computeFreeReportStats } from "../src/report";
import {
  bilingualPlan,
  ENGINES,
  fixture,
  reportInput as inputOf,
  mention,
  plan,
  RIVAL,
  TARGET,
} from "./fixtures/report-200";

const MAIN = plan.observations.length;

// The target is recommended in half of the Spanish answers and a quarter of the English ones.
const mentions = (slot: number) =>
  (slot < MAIN ? slot % 2 === 0 : slot % 4 === 0)
    ? [mention({ entityKey: TARGET }), mention({ entityKey: RIVAL, ordinal: 2 })]
    : [mention({ entityKey: RIVAL })];

const bilingual = (over: Parameters<typeof fixture>[0] = {}) =>
  fixture({ plan: bilingualPlan(), languageShares: { es: 0.89, en: 0.11 }, mentions, ...over });

function languageMass(f: ObservationFrame, language: "es" | "en"): number {
  const strata = new Map<string, number>();
  for (const c of f.captures) if (c.language === language) strata.set(c.stratum, c.weight);
  return [...strata.values()].reduce((a, b) => a + b, 0);
}

describe("two-language weighting", () => {
  test("each language weighs its search share, split equally across its engines", () => {
    const f = buildObservations(bilingual());
    expect(languageMass(f, "es")).toBeCloseTo(0.89, 12);
    expect(languageMass(f, "en")).toBeCloseTo(0.11, 12);
    const en = f.captures.find((c) => c.language === "en");
    expect(en?.weight).toBeCloseTo(0.11 / 5 / 5, 12);
    expect(f.languages).toMatchObject([
      { language: "es", searchShare: 0.89, planned: 200, valid: 200, included: true },
      { language: "en", searchShare: 0.11, planned: 100, valid: 100, included: true },
    ]);
  });

  test("shares are normalized", () => {
    const a = buildObservations(bilingual({ languageShares: { es: 89, en: 11 } }));
    const b = buildObservations(bilingual());
    expect(a.captures.map((c) => c.weight)).toEqual(b.captures.map((c) => c.weight));
  });

  test("a second-language engine stays in with half its planned answers and leaves below", () => {
    const f = buildObservations(bilingual({ secondaryFailed: { gemini: 10, perplexity: 11 } }));
    const enEngines = new Set(
      f.captures.filter((c) => c.language === "en" && c.weight > 0).map((c) => c.engine),
    );
    expect(enEngines.has("gemini")).toBe(true);
    expect(enEngines.has("perplexity")).toBe(false);
    expect(languageMass(f, "en")).toBeCloseTo(0.11, 12);
    // Perplexity still counts in Spanish, so the engine stays in the report.
    expect(f.engines.find((e) => e.engine === "perplexity")?.included).toBe(true);
  });

  test("a language with no engine left hands its share to the other", () => {
    const failed = Object.fromEntries(ENGINES.map((e) => [e, 20])) as Record<EngineId, number>;
    const f = buildObservations(bilingual({ secondaryFailed: failed }));
    expect(languageMass(f, "es")).toBeCloseTo(1, 12);
    expect(f.languages[1]).toMatchObject({ language: "en", valid: 0, included: false });
  });

  test("refuses missing or invalid shares, a second sample under the floor and stray languages", () => {
    expect(() => buildObservations(bilingual({ languageShares: { es: 1 } }))).toThrow(/share/);
    expect(() => buildObservations(bilingual({ languageShares: { es: 1, en: 0 } }))).toThrow(
      /share/,
    );
    expect(() =>
      buildObservations(fixture({ plan: bilingualPlan(3), languageShares: { es: 1, en: 1 } })),
    ).toThrow(/half/);
    const stray = bilingualPlan();
    stray.observations[0] = {
      ...(stray.observations[0] as (typeof stray.observations)[0]),
      language: "fr",
    };
    expect(() =>
      buildObservations(fixture({ plan: stray, languageShares: { es: 1, en: 1 } })),
    ).toThrow(/fr/);
    const unnamed = { ...bilingualPlan() };
    delete unnamed.language;
    expect(() =>
      buildObservations(fixture({ plan: unnamed, languageShares: { es: 1, en: 1 } })),
    ).toThrow(/main language/);
  });

  test("a one-language report ignores shares and lists no languages", () => {
    const f = buildObservations(fixture({ languageShares: { es: 1, en: 3 } }));
    expect(f.languages).toEqual([]);
    for (const c of f.captures) expect(c.weight).toBeCloseTo(1 / 25, 15);
    expect(f.engines.every((e) => e.sharesFrame)).toBe(true);
  });
});

describe("two-language report", () => {
  test("the headline mixes the languages by share with the stratified variance", () => {
    const stats = computeFreeReportStats(
      inputOf({ plan: bilingualPlan(), languageShares: { es: 0.89, en: 0.11 }, mentions }),
    );
    const rate = stats.target.overall?.components.recommendationRate;
    expect(rate?.estimate).toBeCloseTo(0.89 * 0.5 + 0.11 * 0.25, 12);
    // Var(p̂) = Σ W_h² p_h(1 − p_h)/n_h over 25 strata per language; n_eff = p̂(1 − p̂)/Var,
    // capped at Kish's 1/Σ W_h²/n_h.
    const variance = (25 * ((0.89 / 25) ** 2 * 0.25)) / 8 + (25 * ((0.11 / 25) ** 2 * 0.1875)) / 4;
    const kish = 1 / ((25 * (0.89 / 25) ** 2) / 8 + (25 * (0.11 / 25) ** 2) / 4);
    const p = 0.89 * 0.5 + 0.11 * 0.25;
    expect(rate?.effectiveTrials).toBeCloseTo(Math.min((p * (1 - p)) / variance, kish), 9);
    expect(rate?.trials).toBe(300);

    const [es, en] = stats.languages;
    expect(es).toMatchObject({ language: "es", searchShare: 0.89, included: true });
    expect(es?.targetScore?.components.recommendationRate).toMatchObject({
      estimate: 0.5,
      trials: 200,
    });
    expect(en?.targetScore?.components.recommendationRate).toMatchObject({
      estimate: 0.25,
      trials: 100,
    });
    expect(en?.targetCounts).toMatchObject({ recommended: 25, validCaptures: 100 });
    const { value, lower, upper } = en?.targetScore ?? { value: 0, lower: 0, upper: 0 };
    expect(lower <= value && value <= upper).toBe(true);
  });

  test("an engine's own score weighs its languages by share, whatever other engines did", () => {
    // Four engines are lost in English, so English engines weigh 1/1 and Spanish ones 1/5.
    const failed = Object.fromEntries(
      ENGINES.filter((e) => e !== "gemini").map((e) => [e, 20]),
    ) as Record<EngineId, number>;
    const stats = computeFreeReportStats(
      inputOf({
        plan: bilingualPlan(),
        languageShares: { es: 0.5, en: 0.5 },
        secondaryFailed: failed,
        mentions,
      }),
    );
    const gemini = stats.target.byEngine.gemini?.score.components.recommendationRate;
    expect(gemini?.estimate).toBeCloseTo(0.5 * 0.5 + 0.5 * 0.25, 12);
  });
});
