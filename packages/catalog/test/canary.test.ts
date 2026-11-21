import type { SeedCatalogFile } from "@reranker/schema/measurement";
import { describe, expect, test } from "vitest";
import { CANARY_GEOS, canaryFrom } from "../src/canary";
import { seedCategories } from "../src/categories";
import { type FrozenSeed, lockedSeed } from "../src/seed/load";
import { fallbackTemplates } from "../src/templates";

const entry = {
  version: "2026.11.0",
  contentHash: "a".repeat(64),
  merkleRoot: "b".repeat(64),
  variantCount: 0,
};

// Six intents per seed category from the archetype's templates, the first five in the free
// report; an English copy of each shows the canary only asks the Colombian Spanish questions.
function catalog(): SeedCatalogFile {
  const file: SeedCatalogFile = { categories: [], intents: [], personas: [], paraphrases: [] };
  for (const c of seedCategories()) {
    const { key, labelKey, placesTypes, synonyms, archetype, defaultScope, register } = c;
    file.categories.push({
      key,
      labelKey,
      placesTypes,
      synonyms,
      archetype,
      defaultScope,
      register,
    });
    for (const language of ["es", "en"] as const) {
      const registerProfile = language === "es" ? "co" : "neutral";
      const prefix = language === "es" ? "" : "en-";
      file.personas.push({
        personaId: `${key}.${prefix}parent`,
        categoryKey: key,
        preamble: language === "es" ? "Tengo dos hijos." : "I have two kids.",
        language,
        registerProfile,
      });
      fallbackTemplates(archetype, defaultScope, language).forEach((t, i) => {
        const intentId = `${key}.${prefix}${t.slug}` as const;
        file.intents.push({
          intentId,
          categoryKey: key,
          scope: defaultScope,
          kind: t.kind,
          slug: `${prefix}${t.slug}`,
          labelKey: `catalog.intents.${key}.${t.slug}`,
          canonicalText: t.canonical,
          canonicalParaphraseId: `${intentId}.p00`,
          demandWeight: 1,
          freeReport: i < 5,
          language,
          registerProfile,
        });
        [t.canonical, t.paraphrases[0]?.text ?? t.canonical].forEach((text, n) => {
          file.paraphrases.push({
            paraphraseId: `${intentId}.p0${n}`,
            intentId,
            text,
            format: n === 0 ? "open_question" : "keyword",
            generator: "human",
            humanReviewed: true,
          });
        });
      });
    }
  }
  return file;
}

const seed = lockedSeed([entry], "2026.11.0", catalog) as FrozenSeed;
const canary = canaryFrom(seed);

describe("canary@3", () => {
  test("50 prompts: the same 25 canonical questions in Bogotá and in Medellín", () => {
    expect(canary.id).toBe("canary@3");
    expect(canary.geos).toEqual(["co-c1003659", "co-c1003654"]);
    expect(canary.variants).toHaveLength(50);
    const [bogota, medellin] = CANARY_GEOS.map((g) =>
      canary.variants.filter((v) => v.geoKey === g).map((v) => v.intentId),
    );
    expect(bogota).toHaveLength(25);
    expect(medellin).toEqual(bogota);
    expect(canary.variants.every((v) => v.isCanonical && v.personaId === null)).toBe(true);
  });

  test("the rule: free-report canonicals without zone questions, in catalog order, first 25", () => {
    const expected = seed.catalog.intents
      .filter((i) => i.language === "es" && i.freeReport && i.kind !== "zone")
      .map((i) => i.intentId)
      .slice(0, 25);
    expect(canary.variants.slice(0, 25).map((v) => v.intentId)).toEqual(expected);
    expect(new Set(canary.variants.map((v) => v.intentId.split(".")[0])).size).toBe(6);
  });

  test("every prompt is filled with the city and the category's Spanish noun", () => {
    expect(canary.variants.every((v) => !v.prompt.includes("{"))).toBe(true);
    const dental = canary.variants.find((v) => v.intentId === "dental_clinic.recommended");
    expect(dental?.prompt).toBe("¿Qué clínica odontológica me recomiendas en Bogotá?");
    const store = canary.variants.find((v) => v.intentId.startsWith("online_store."));
    expect(store?.prompt).toContain("ropa");
  });

  test("stable across calls", () => expect(canaryFrom(seed)).toEqual(canary));

  test("every question names the seed version's intent set and its own scope", () => {
    expect(canary.intentSetId).toBe(`is_${entry.contentHash.slice(0, 16)}`);
    const scopes = new Map(seed.catalog.intents.map((i) => [i.intentId, i.scope]));
    expect(canary.variants.every((v) => v.scope === scopes.get(v.intentId))).toBe(true);
  });

  test("a seed with fewer than 25 such questions is refused", () => {
    const short = catalog();
    const kept = short.intents.filter((i) => !i.intentId.startsWith("hotel."));
    const thin = lockedSeed([entry], "2026.11.0", () => ({ ...short, intents: kept }));
    expect(() => canaryFrom(thin)).toThrow(/canary/);
  });
});

describe("pinned seed versions", () => {
  test("a registered version is read by its own entry, not the newest", () => {
    const newer = { ...entry, version: "2026.12.0", contentHash: "c".repeat(64) };
    expect(lockedSeed([entry, newer], "2026.11.0", catalog).contentHash).toBe(entry.contentHash);
  });

  test("a version that was never frozen is refused", () =>
    expect(() => lockedSeed([entry], "2026.12.0", catalog)).toThrow(/2026\.12\.0/));
});
