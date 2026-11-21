import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { getGeo, nounGenders, seedCategories } from "@reranker/catalog";
import { endPools } from "@reranker/db";
import type { SpendContext } from "@reranker/jobs";
import type {
  BusinessCandidate,
  CategoryArchetype,
  MeasurementLanguage,
  QuestionScope,
} from "@reranker/schema/measurement";
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

// Six gpt-6-luna classifications, about one US cent in all.
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

/** Real businesses recorded from Places by `record:categories`, labelled by their Places type. */
interface Recorded {
  language: MeasurementLanguage;
  country: string;
  placeId: string;
  displayName: string;
  types: string[];
  primaryType: string | null;
  primaryTypeDisplayName: string | null;
  googleMapsTypeLabel: string | null;
  pureServiceAreaBusiness: boolean;
  expected: { categoryKey: string; archetype: CategoryArchetype; scope: QuestionScope };
}

const recorded = (
  JSON.parse(readFileSync(new URL("fixtures/category-60.json", import.meta.url), "utf8")) as {
    businesses: Recorded[];
  }
).businesses;
const seedKeys = new Set<string>(seedCategories().map((s) => s.key));

/**
 * The seed key or Table A type Places gave. Outside the seed, a language whose questions agree
 * with the noun needs the classifier to name the business, so there the category is right when
 * the archetype matches and no seed it is not was claimed.
 */
function categoryRight(b: Recorded, c: { key: string; archetype: CategoryArchetype }): boolean {
  if (seedKeys.has(b.expected.categoryKey) || nounGenders(b.language).length === 0) {
    return c.key === b.expected.categoryKey;
  }
  return c.archetype === b.expected.archetype && !seedKeys.has(c.key);
}

// Classifier calls only where the rules do not decide: a few US cents in all.
test("infers the category of 60 real businesses in six languages and their scope", async () => {
  const misses: string[] = [];
  let categories = 0;
  let scopes = 0;
  for (const b of recorded) {
    const c = await inferCategory(
      {
        kind: "place",
        placeId: b.placeId,
        domain: null,
        displayName: b.displayName,
        formattedAddress: null,
        geo: getGeo(b.country.toLowerCase()),
        neighborhood: null,
        categoryHint: null,
        confidence: 1,
        attribution: "Google Maps",
        places: {
          types: b.types,
          primaryType: b.primaryType,
          primaryTypeDisplayName: b.primaryTypeDisplayName,
          googleMapsTypeLabel: b.googleMapsTypeLabel,
          pureServiceAreaBusiness: b.pureServiceAreaBusiness,
        },
      },
      { spend },
    );
    const category = categoryRight(b, c);
    const scope = c.scope === b.expected.scope;
    if (category) categories++;
    if (scope) scopes++;
    if (!category || !scope) {
      misses.push(
        `${b.language} ${b.displayName}: ${c.key} ${c.archetype} ${c.scope}, expected ${b.expected.categoryKey} ${b.expected.archetype} ${b.expected.scope}`,
      );
    }
  }
  const summary = `category ${categories}/${recorded.length}, scope ${scopes}/${recorded.length}`;
  console.log([summary, ...misses].join("\n"));
  expect(categories / recorded.length, summary).toBeGreaterThanOrEqual(0.9);
  expect(scopes / recorded.length, summary).toBeGreaterThanOrEqual(0.95);
}, 300_000);
