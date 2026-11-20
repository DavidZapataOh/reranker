import { isAppError } from "@reranker/schema";
import { PromptVariant } from "@reranker/schema/measurement";
import { describe, expect, test } from "vitest";
import { getGeo } from "../src/geo/resolve";
import { promptSha256, variantId } from "../src/hash";
import { buildVariants, instantiate } from "../src/variants";
import { dentalSet } from "./fixtures/intent-set";

const ctx = {
  place: "Bogotá",
  zone: "Chapinero",
  country: "Colombia",
  noun: "clínica odontológica",
};

const internal = (fn: () => unknown) =>
  expect(fn).toThrow(expect.objectContaining({ code: "internal" }));

describe("instantiate", () => {
  test("fills every placeholder", () => {
    expect(instantiate("¿Qué {sustantivo} me recomiendas cerca de {zona} en {lugar}?", ctx)).toBe(
      "¿Qué clínica odontológica me recomiendas cerca de Chapinero en Bogotá?",
    );
    expect(instantiate("Mejor {sustantivo} de {país}", ctx)).toBe(
      "Mejor clínica odontológica de Colombia",
    );
    expect(
      instantiate("¿{business} en {lugar} es confiable?", { ...ctx, business: "Sonría" }),
    ).toBe("¿Sonría en Bogotá es confiable?");
  });

  test("a value with braces is copied as is", () =>
    expect(instantiate("¿{business}?", { ...ctx, business: "Café {Origen}" })).toBe(
      "¿Café {Origen}?",
    ));

  test.each([
    ["no neighborhood for {zona}", "cerca de {zona} en {lugar}", { ...ctx, zone: null }],
    ["no business for {business}", "¿{business}?", ctx],
    ["an empty noun", "{sustantivo} en {lugar}", { ...ctx, noun: "" }],
    ["an unknown placeholder", "{ciudad}", ctx],
    ["an inherited property name", "{constructor}", ctx],
    ["a stray brace", "¿Qué {sustantivo en {lugar}?", ctx],
  ])("%s is an internal error", (_, template, c) => internal(() => instantiate(template, c)));
});

describe("buildVariants", () => {
  const set = dentalSet();
  const geo = getGeo("co-c1003659");
  const [discovery, , zone] = set.intents;
  if (!discovery || !zone) throw new Error("fixture lost its intents");

  test("every paraphrase without persona and with each persona of the category", () => {
    const variants = buildVariants(set, discovery.intentId, geo, null, "clínica odontológica");
    expect(variants).toHaveLength(9 * 7);
    for (const v of variants) expect(PromptVariant.parse(v)).toEqual(v);
    expect(new Set(variants.map((v) => v.variantId)).size).toBe(variants.length);
  });

  test("only the canonical paraphrase without persona is canonical", () => {
    const variants = buildVariants(set, discovery.intentId, geo, null, "clínica odontológica");
    const canonical = variants.filter((v) => v.isCanonical);
    expect(canonical).toEqual([
      expect.objectContaining({
        paraphraseId: discovery.canonicalParaphraseId,
        personaId: null,
        prompt: "¿Qué clínica odontológica me recomiendas en Bogotá?",
      }),
    ]);
  });

  test("a persona's preamble opens the prompt, and ids and hashes are deterministic", () => {
    const variants = buildVariants(set, discovery.intentId, geo, null, "clínica odontológica");
    const v = variants.find((x) => x.personaId === "dental_clinic.senior" && !x.isCanonical);
    expect(v?.prompt.startsWith("Pregunto como senior. ")).toBe(true);
    expect(v?.variantId).toBe(
      variantId({
        intentId: discovery.intentId,
        paraphraseId: v?.paraphraseId ?? "",
        personaId: "dental_clinic.senior",
        geoKey: "co-c1003659",
      }),
    );
    expect(v?.promptSha256).toBe(promptSha256(v?.prompt ?? ""));
  });

  test("the neighborhood fills zone intents and is required by them", () => {
    const variants = buildVariants(set, zone.intentId, geo, "Chapinero", "clínica odontológica");
    expect(variants.every((v) => v.prompt.includes("Chapinero"))).toBe(true);
    internal(() => buildVariants(set, zone.intentId, geo, null, "clínica odontológica"));
  });

  test("an unknown intent or a set without the canonical paraphrase is an internal error", () => {
    internal(() => buildVariants(set, "dental_clinic.unknown", geo, null, "clínica"));
    const broken = {
      ...set,
      paraphrases: set.paraphrases.filter(
        (p) => p.paraphraseId !== discovery.canonicalParaphraseId,
      ),
    };
    try {
      buildVariants(broken, discovery.intentId, geo, null, "clínica");
      expect.unreachable();
    } catch (error) {
      expect(isAppError(error) && error.code).toBe("internal");
    }
  });
});
