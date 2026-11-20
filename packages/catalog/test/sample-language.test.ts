import type { EngineId } from "@reranker/schema";
import { MeasurementLanguage, MeasurementPlan } from "@reranker/schema/measurement";
import { describe, expect, test } from "vitest";
import { getGeo } from "../src/geo/resolve";
import { variantId } from "../src/hash";
import { MeasurementLanguageError } from "../src/language";
import { planMeasurement } from "../src/sample";
import { TEMPLATE_LANGUAGES } from "../src/templates";
import { dentalSet, templateSet } from "./fixtures/intent-set";

const ENGINES: readonly EngineId[] = ["chatgpt", "gemini", "google-ai-overview"];

const local = (reportId: string) => ({
  intentSet: dentalSet(),
  geo: getGeo("co-c1003659"),
  scope: "local" as const,
  neighborhood: "Chapinero",
  noun: "clínica odontológica",
  engines: ENGINES,
  reportId,
});

const storeSet = (language: MeasurementLanguage) =>
  templateSet({
    archetype: "online_national",
    scope: "national",
    category: "online_store",
    language,
  });

const national = (reportId: string) => ({
  intentSet: storeSet("es"),
  geo: getGeo("es"),
  scope: "national" as const,
  neighborhood: null,
  noun: "zapatillas",
  engines: ENGINES,
  reportId,
  secondary: { language: "en" as const, intentSet: storeSet("en"), noun: "sneakers" },
});

const alone = (reportId: string) => {
  const { secondary: _, ...input } = national(reportId);
  return input;
};

function refusal(plan: () => unknown): unknown {
  try {
    plan();
  } catch (error) {
    return error;
  }
  throw new Error("the plan was not refused");
}

describe("planMeasurement languages", () => {
  test("by default every question is asked in the country's main language", () => {
    const plan = planMeasurement(local("r-1"));
    expect(plan.language).toBe("es");
    expect(plan.secondary).toBeUndefined();
    expect(plan.observations.every((o) => o.language === "es")).toBe(true);
  });

  test("the main language keeps the variant ids it had before languages were recorded", () => {
    const o = planMeasurement(local("r-1")).observations[0];
    expect(o?.variantId).toBe(
      variantId({
        intentId: o?.intentId ?? "",
        paraphraseId: o?.paraphraseId ?? "",
        personaId: o?.personaId ?? null,
        geoKey: "co-c1003659",
      }),
    );
  });

  test("a set in another language than the one planned is refused", () => {
    expect(() => planMeasurement({ ...local("r-1"), intentSet: dentalSet("en") })).toThrow(
      expect.objectContaining({ code: "internal" }),
    );
    // The United States is measured in English, so a Spanish set needs Spanish asked for.
    const us = { ...alone("r-1"), geo: getGeo("us") };
    expect(() => planMeasurement(us)).toThrow(expect.objectContaining({ code: "internal" }));
    expect(planMeasurement({ ...us, language: "es" }).language).toBe("es");
  });

  test("a country whose main language is not measured fails closed", () => {
    const error = refusal(() => planMeasurement({ ...alone("r-1"), geo: getGeo("nl") }));
    expect(error).toBeInstanceOf(MeasurementLanguageError);
    expect(error).toMatchObject({ language: "nl", gap: "unsupported" });
  });

  test.each(MeasurementLanguage.options.filter((l) => !TEMPLATE_LANGUAGES.includes(l)))(
    "a %s measurement fails closed until its templates land",
    (language) => {
      for (const input of [
        { ...alone("r-1"), language },
        { ...alone("r-1"), secondary: { language, intentSet: storeSet("es"), noun: "x" } },
      ]) {
        const error = refusal(() => planMeasurement(input));
        expect(error).toBeInstanceOf(MeasurementLanguageError);
        expect(error).toMatchObject({ language, gap: "no_templates" });
      }
    },
  );

  test("a city cannot be named in a language the location data has no names in", () => {
    const secondary = { language: "en" as const, intentSet: dentalSet("en"), noun: "dentist" };
    const error = refusal(() => planMeasurement({ ...local("r-1"), secondary }));
    expect(error).toBeInstanceOf(MeasurementLanguageError);
    expect(error).toMatchObject({ language: "en", gap: "no_place_names" });
  });

  test("a second language adds half the sample and leaves the main one untouched", () => {
    const main = planMeasurement(alone("r-2"));
    const both = planMeasurement(national("r-2"));
    expect(MeasurementPlan.parse(both)).toEqual(both);
    expect(both.observations.slice(0, main.observations.length)).toEqual(main.observations);
    const added = both.observations.slice(main.observations.length);
    expect(added).toHaveLength(main.observations.length / 2);
    expect(added.every((o) => o.language === "en")).toBe(true);
    expect(both.secondary).toEqual({
      language: "en",
      intentSet: storeSet("en").manifest,
      design: { intents: 5, variantsPerIntent: 4, runsPerVariant: 1 },
    });
    expect(new Set(added.map((o) => o.intentId))).toEqual(
      new Set(main.observations.map((o) => o.intentId)),
    );
  });

  test("each language names the country its own way and has its own variant ids", () => {
    const plan = planMeasurement(national("r-3"));
    const prompts = (language: string) =>
      plan.observations.filter((o) => o.language === language).map((o) => o.promptText);
    expect(prompts("es").some((p) => p.includes("España"))).toBe(true);
    expect(prompts("en").some((p) => p.includes("Spain"))).toBe(true);
    expect(prompts("en").some((p) => p.includes("España"))).toBe(false);
    expect(prompts("en").every((p) => !p.includes("zapatillas"))).toBe(true);
    const ids = (language: string) =>
      new Set(plan.observations.filter((o) => o.language === language).map((o) => o.variantId));
    expect([...ids("en")].some((id) => ids("es").has(id))).toBe(false);
  });

  test("the second language cannot repeat the main one", () =>
    expect(() =>
      planMeasurement({
        ...national("r-4"),
        secondary: { language: "es", intentSet: storeSet("es"), noun: "zapatillas" },
      }),
    ).toThrow(expect.objectContaining({ code: "internal" })));
});
