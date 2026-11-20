import { describe, expect, expectTypeOf, test } from "vitest";
import {
  BusinessCategory,
  CategoryKey,
  GeoKey,
  GeoTarget,
  IntentId,
  IntentSet,
  IntentSetId,
  MeasurementPlan,
  PlacesAddressComponent,
  PlannedObservation,
  PlannedSlot,
  PromptVariant,
  SeedCatalogFile,
  SeedCategoryKey,
  VariantId,
} from "../src/measurement/catalog";
import * as measurement from "../src/measurement/index";

const hex = (c: string) => c.repeat(64);

const medellin = {
  key: "co-c1003654",
  level: "city",
  country: "CO",
  name: "Medellín",
  regionName: "Antioquia",
  center: { lat: 6.2442, lng: -75.5812, level: "city", label: "Medellín" },
  dataforseo: { locationCode: 1003654, level: "city", label: "Medellin,Antioquia,Colombia" },
  enrichment: { divipola: { municipalityCode: "05001", departmentCode: "05" } },
  geoDataHash: hex("a"),
};

const manifest = {
  id: "is_0123456789abcdef",
  kind: "seed",
  version: "2026.11.0",
  categoryKey: "dental_clinic",
  scope: "local",
  registerProfile: "co",
  contentHash: hex("b"),
  merkleRoot: hex("c"),
  variantCount: 210,
  generatorConfigHash: null,
  generators: 0,
};

const observationFixture = {
  engine: "chatgpt",
  provider: "brightdata",
  intentSetId: "is_0123456789abcdef",
  intentId: "dental_clinic.best_clinic",
  paraphraseId: "dental_clinic.best_clinic.p01",
  geoKey: "co-c1003654",
  geoDeclared: { level: "city", label: "Medellín" },
  runIndex: 0,
  promptText: "¿Cuál es la mejor clínica odontológica en Medellín?",
  variantId: "pv_0123456789abcdef",
  promptSha256: hex("d"),
  isCanonical: true,
};

const planFixture = {
  intentSet: manifest,
  geo: medellin,
  scope: "local",
  seed: hex("e"),
  design: { intents: 5, variantsPerIntent: 8, runsPerVariant: 1 },
  observations: [observationFixture],
};

describe("measurement catalog schemas", () => {
  test("PlannedObservation is a PlannedSlot", () => {
    expectTypeOf<PlannedObservation>().toMatchTypeOf<PlannedSlot>();
    expect(PlannedSlot.safeParse(observationFixture).success).toBe(true);
    expect(PlannedObservation.parse(observationFixture)).toEqual(observationFixture);
  });

  test("a PlannedSlot may repeat a run but a PlannedObservation is always run 0", () => {
    const { variantId, promptSha256, isCanonical, ...slot } = observationFixture;
    expect(PlannedSlot.safeParse({ ...slot, runIndex: 3 }).success).toBe(true);
    expect(PlannedObservation.safeParse({ ...observationFixture, runIndex: 1 }).success).toBe(
      false,
    );
    expect(PlannedObservation.safeParse(slot).success).toBe(false);
  });

  test.each(["co", "co-c1003654", "mx-r20584", "es-c1005424"])("accepts geo key %s", (k) =>
    expect(GeoKey.parse(k)).toBe(k),
  );
  test.each(["CO", "co-05001", "co-x1", ""])("rejects geo key %s", (k) =>
    expect(GeoKey.safeParse(k).success).toBe(false),
  );

  test("MeasurementPlan requires runsPerVariant 1 and a hex seed", () => {
    expect(MeasurementPlan.safeParse(planFixture).success).toBe(true);
    expect(
      MeasurementPlan.safeParse({
        ...planFixture,
        design: { intents: 5, variantsPerIntent: 8, runsPerVariant: 2 },
      }).success,
    ).toBe(false);
    expect(MeasurementPlan.safeParse({ ...planFixture, seed: "xyz" }).success).toBe(false);
  });

  test("SeedCategoryKey is the closed list of six", () =>
    expect(SeedCategoryKey.options).toEqual([
      "dental_clinic",
      "restaurant",
      "hotel",
      "car_repair",
      "real_estate_agency",
      "online_store",
    ]));

  test("category keys outside the seed are gen-prefixed", () => {
    expect(CategoryKey.safeParse("gen:places:bakery").success).toBe(true);
    expect(CategoryKey.safeParse("gen:cafe-de-origen").success).toBe(true);
    expect(CategoryKey.safeParse("bakery").success).toBe(false);
    expect(CategoryKey.safeParse("gen:").success).toBe(false);
  });

  test("ids carry their prefix and a 16-hex digest", () => {
    expect(IntentSetId.safeParse("is_0123456789abcdef").success).toBe(true);
    expect(IntentSetId.safeParse("is_0123").success).toBe(false);
    expect(VariantId.safeParse("pv_0123456789abcdef").success).toBe(true);
    expect(VariantId.safeParse("pv_0123456789ABCDEF").success).toBe(false);
    expect(IntentId.safeParse("gen:places:bakery.discovery").success).toBe(true);
    expect(IntentId.safeParse("bakery.discovery").success).toBe(false);
  });

  test("GeoTarget validates the DIVIPOLA enrichment and accepts a bare country", () => {
    expect(GeoTarget.safeParse(medellin).success).toBe(true);
    expect(
      GeoTarget.safeParse({
        ...medellin,
        enrichment: { divipola: { municipalityCode: "5001", departmentCode: "05" } },
      }).success,
    ).toBe(false);
    const country = {
      key: "mx",
      level: "country",
      country: "MX",
      name: "México",
      regionName: null,
      center: null,
      dataforseo: { locationCode: 2484, level: "country", label: "Mexico" },
      enrichment: null,
      geoDataHash: hex("f"),
    };
    expect(GeoTarget.safeParse(country).success).toBe(true);
  });

  test("PlacesAddressComponent follows Places API (New)", () => {
    const component = {
      longText: "Medellín",
      shortText: "Medellín",
      types: ["locality", "political"],
      languageCode: "es",
    };
    expect(PlacesAddressComponent.parse(component)).toEqual(component);
    const { languageCode, ...withoutLanguage } = component;
    expect(PlacesAddressComponent.safeParse(withoutLanguage).success).toBe(true);
  });

  test("BusinessCategory accepts an inferred category", () =>
    expect(
      BusinessCategory.safeParse({
        key: "gen:places:bakery",
        source: "places_type",
        label: "Panadería",
        noun: "panadería",
        archetype: "food",
        scope: "local",
        register: "tu",
        placesTypes: ["bakery"],
      }).success,
    ).toBe(true));

  test("IntentSet holds its intents, paraphrases and personas", () => {
    const set = {
      manifest,
      intents: [
        {
          intentId: "dental_clinic.best_clinic",
          intentSetId: manifest.id,
          categoryKey: "dental_clinic",
          scope: "local",
          kind: "discovery",
          slug: "best_clinic",
          labelKey: "catalog.intents.dental_clinic.best_clinic",
          canonicalText: "¿Cuál es la mejor clínica odontológica en {lugar}?",
          canonicalParaphraseId: "dental_clinic.best_clinic.p00",
          demandWeight: 1,
          freeReport: true,
          language: "es",
          registerProfile: "co",
        },
      ],
      paraphrases: [
        {
          paraphraseId: "dental_clinic.best_clinic.p00",
          intentId: "dental_clinic.best_clinic",
          text: "¿Cuál es la mejor clínica odontológica en {lugar}?",
          format: "open_question",
          generator: "openai",
          humanReviewed: true,
        },
      ],
      personas: [
        {
          personaId: "dental_clinic.parent",
          categoryKey: "dental_clinic",
          preamble: "Soy mamá de dos niños pequeños.",
        },
      ],
    };
    expect(IntentSet.parse(set)).toEqual(set);
    expect(
      IntentSet.safeParse({ ...set, intents: [{ ...set.intents[0], language: "en" }] }).success,
    ).toBe(false);
  });

  test("PromptVariant without persona is null, never missing", () => {
    const variant = {
      variantId: "pv_0123456789abcdef",
      intentId: "dental_clinic.best_clinic",
      paraphraseId: "dental_clinic.best_clinic.p00",
      personaId: null,
      format: "open_question",
      isCanonical: true,
      prompt: "¿Cuál es la mejor clínica odontológica en Medellín?",
      promptSha256: hex("d"),
    };
    expect(PromptVariant.safeParse(variant).success).toBe(true);
    const { personaId, ...missing } = variant;
    expect(PromptVariant.safeParse(missing).success).toBe(false);
  });

  test("a seed catalog file holds categories and set-free intents, personas and paraphrases", () => {
    const file = {
      categories: [
        {
          key: "dental_clinic",
          labelKey: "catalog.categories.dental_clinic",
          placesTypes: ["dental_clinic", "dentist"],
          synonyms: ["odontólogo"],
          archetype: "health",
          defaultScope: "local",
          register: "usted",
        },
      ],
      intents: [
        {
          intentId: "dental_clinic.best_clinic",
          categoryKey: "dental_clinic",
          scope: "local",
          kind: "discovery",
          slug: "best_clinic",
          labelKey: "catalog.intents.dental_clinic.best_clinic",
          canonicalText: "¿Cuál es la mejor clínica odontológica en {lugar}?",
          canonicalParaphraseId: "dental_clinic.best_clinic.p00",
          demandWeight: 1,
          freeReport: true,
          language: "es",
          registerProfile: "co",
        },
      ],
      personas: [
        { personaId: "dental_clinic.parent", categoryKey: "dental_clinic", preamble: "Soy mamá." },
      ],
      paraphrases: [
        {
          paraphraseId: "dental_clinic.best_clinic.p00",
          intentId: "dental_clinic.best_clinic",
          text: "¿Cuál es la mejor clínica odontológica en {lugar}?",
          format: "open_question",
          generator: "human",
          humanReviewed: true,
        },
      ],
    };
    expect(SeedCatalogFile.parse(file)).toEqual(file);
    const generated = { ...file.categories[0], key: "gen:places:bakery" };
    expect(SeedCatalogFile.safeParse({ ...file, categories: [generated] }).success).toBe(false);
    const unlabeled = { ...file.intents[0], labelKey: null };
    expect(SeedCatalogFile.safeParse({ ...file, intents: [unlabeled] }).success).toBe(false);
  });

  test("the measurement entry point exposes the catalog schemas", () => {
    expect(measurement.MeasurementPlan).toBe(MeasurementPlan);
    expect(measurement.PlannedSlot).toBe(PlannedSlot);
  });
});
