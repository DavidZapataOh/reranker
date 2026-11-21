import { randomUUID } from "node:crypto";
import { getGeo } from "@reranker/catalog";
import { endPools } from "@reranker/db";
import type { SpendContext } from "@reranker/jobs";
import type { BusinessCandidate, MeasurementLanguage } from "@reranker/schema/measurement";
import { requireEnv } from "@reranker/testing/env";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { inferCategory } from "../src/category";

const spend: SpendContext = {
  purpose: "contract-test",
  refType: "category-contract",
  refId: randomUUID(),
};

beforeAll(() => {
  vi.stubEnv("APP_ENV", process.env.APP_ENV || "development");
  vi.stubEnv("OPENAI_API_KEY", requireEnv("OPENAI_API_KEY_CI"));
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await endPools();
});

// Places labels come in Spanish whatever the country; names carry no category word, so the
// classifier has to name the business in its own language from the Spanish label alone.
function bakery(name: string, country: string): BusinessCandidate {
  return {
    kind: "place",
    placeId: `contract-${country}`,
    domain: null,
    displayName: name,
    formattedAddress: null,
    geo: getGeo(country),
    neighborhood: null,
    categoryHint: null,
    confidence: 1,
    attribution: "Google Maps",
    places: {
      types: ["food", "store", "point_of_interest", "establishment"],
      primaryType: null,
      primaryTypeDisplayName: "Panadería",
      googleMapsTypeLabel: "Panadería",
      pureServiceAreaBusiness: false,
    },
  };
}

// Six gpt-6-luna classifications, about one US cent in all. The accuracy gate over labelled
// businesses (category ≥ 90 %, scope ≥ 95 %) belongs to the benchmark.
test.each([
  ["co", "es", "La Espiga Dorada", /panader/i, [null]],
  ["us", "en", "Golden Crust", /bak/i, [null]],
  ["br", "pt", "Trigo Dourado", /padaria|panifica/i, ["f"]],
  ["fr", "fr", "Maison Dupont", /boulang/i, ["f"]],
  ["de", "de", "Müller am Markt", /b(ä|ae|a)cker/i, ["f"]],
  ["it", "it", "Da Rossi", /panett|panific|forn/i, ["m", "f"]],
] as const)(
  "a bakery in %s is named in %s, never translated",
  async (country, language, name, noun, genders) => {
    const c = await inferCategory(bakery(name, country), { spend });
    expect(c).toMatchObject({
      source: "inferred",
      archetype: "food",
      scope: "local",
      language: language satisfies MeasurementLanguage,
    });
    // A fallback answers at 0.5: anything else came from the model.
    expect(c.confidence).not.toBe(0.5);
    expect(c.noun).toMatch(noun);
    expect(genders as readonly (string | null)[]).toContain(c.nounGender);
  },
  30_000,
);
