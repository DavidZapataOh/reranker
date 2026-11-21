import { getGeo } from "@reranker/catalog";
import type { BusinessCandidate } from "@reranker/schema/measurement";
import { describe, expect, test } from "vitest";
import { categoryByRules } from "../src/category";

function place(
  over: Partial<NonNullable<BusinessCandidate["places"]>> & { country?: string } = {},
): BusinessCandidate {
  const { country = "co", ...places } = over;
  const primaryType = places.primaryType ?? null;
  return {
    kind: "place",
    placeId: "ChIJ-test",
    domain: null,
    displayName: "La Espiga",
    formattedAddress: null,
    geo: getGeo(country),
    neighborhood: null,
    categoryHint: null,
    confidence: 0.95,
    attribution: "Google Maps",
    places: {
      types: primaryType ? [primaryType, "point_of_interest", "establishment"] : [],
      primaryType,
      primaryTypeDisplayName: null,
      googleMapsTypeLabel: null,
      pureServiceAreaBusiness: false,
      ...places,
    },
  };
}

function website(
  page: { title?: string; description?: string },
  country: string | null = "co",
): BusinessCandidate {
  return {
    kind: "website",
    placeId: null,
    domain: "tienda-ejemplo.com",
    displayName: page.title ?? "tienda-ejemplo.com",
    formattedAddress: null,
    geo: country === null ? null : getGeo(country),
    neighborhood: null,
    categoryHint: null,
    confidence: 1,
    attribution: null,
    website: { title: page.title ?? null, siteName: null, description: page.description ?? null },
  };
}

describe("categoryByRules", () => {
  test("a seed type maps to its seed category with high confidence", () =>
    expect(categoryByRules(place({ primaryType: "dental_clinic" }))).toMatchObject({
      key: "dental_clinic",
      source: "seed",
      confidence: 0.95,
      label: "Clínica odontológica",
      noun: "clínica odontológica",
      scope: "local",
      register: "tu",
      placesTypes: ["dental_clinic", "dentist"],
      language: "es",
      nounGender: null,
    }));

  test("a Table A type outside the seed becomes gen:places:<type> labelled by Google", () =>
    expect(
      categoryByRules(place({ primaryType: "bakery", primaryTypeDisplayName: "Panadería" })),
    ).toMatchObject({
      key: "gen:places:bakery",
      source: "places_type",
      label: "Panadería",
      noun: "panadería",
      archetype: "food",
      scope: "local",
      placesTypes: ["bakery"],
    }));

  test("without Google's label the catalog's Spanish label names the type", () =>
    expect(categoryByRules(place({ primaryType: "bakery" }))).toMatchObject({
      label: "Panadería",
      noun: "panadería",
    }));

  test.each(["store", "point_of_interest", "establishment"])(
    "generic type %s needs the classifier",
    (t) => expect(categoryByRules(place({ primaryType: t, types: [t] }))).toBeNull(),
  );

  test("a specific type after a generic primary type still decides", () =>
    expect(
      categoryByRules(place({ primaryType: "store", types: ["store", "dentist"] })),
    ).toMatchObject({ key: "dental_clinic", source: "seed" }));

  test("a website has no Places type to go by", () =>
    expect(categoryByRules(website({ title: "Café de origen" }))).toBeNull());

  // The reviewed seed names its categories in every language from that language's searches.
  test.each([
    ["us", "en", "dentist", null],
    ["br", "pt", "dentista", "m"],
    ["fr", "fr", "dentiste", "m"],
    ["de", "de", "Zahnarzt", "m"],
    ["it", "it", "dentista", "m"],
  ] as const)("in %s a seed type is named in %s with its gender", (country, language, noun, g) =>
    expect(categoryByRules(place({ primaryType: "dentist", country }))).toMatchObject({
      key: "dental_clinic",
      noun,
      language,
      nounGender: g,
    }),
  );

  // Google's type labels come in Spanish; outside Spanish the classifier names the business.
  test.each(["us", "br", "fr", "de", "it"])("in %s a Table A type goes to the classifier", (c) =>
    expect(
      categoryByRules(
        place({ primaryType: "bakery", primaryTypeDisplayName: "Panadería", country: c }),
      ),
    ).toBeNull(),
  );

  test("an explicit language overrides the country's", () =>
    expect(categoryByRules(place({ primaryType: "dentist", country: "co" }), "en")).toMatchObject({
      noun: "dentist",
      language: "en",
    }));

  // Such a business is refused when its questions are built; until then it is named in Spanish.
  test("a country without a measured language names the seed in Spanish", () =>
    expect(categoryByRules(place({ primaryType: "dentist", country: "jp" }))).toMatchObject({
      noun: "clínica odontológica",
      language: "es",
    }));
});
