import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { CountryCode } from "@reranker/i18n/countries";
import { isAppError } from "@reranker/schema";
import type { GeoTarget, PlacesAddressComponent } from "@reranker/schema/measurement";
import { beforeEach, describe, expect, test } from "vitest";
import { geoForEngine, readChatgptCityEffect } from "../src/geo/effects";
import { cityDisplayName, getGeo, resolveGeo, spokenPlaceName } from "../src/geo/resolve";
import { loadedCountries, resetGeoCache } from "../src/testing";

type PlaceFixture = {
  addressComponents: PlacesAddressComponent[];
  location: { latitude: number; longitude: number };
};

const fixture = (name: string): PlaceFixture =>
  JSON.parse(readFileSync(new URL(`./fixtures/places/${name}.json`, import.meta.url), "utf8"));

const resolveFixture = (country: string, name: string, withLocation = false): GeoTarget => {
  const { addressComponents, location } = fixture(name);
  return resolveGeo({
    country: country as CountryCode,
    addressComponents,
    ...(withLocation ? { location: { lat: location.latitude, lng: location.longitude } } : {}),
  });
};

beforeEach(() => resetGeoCache());

describe("resolveGeo", () => {
  test("Medellín from Places components", () =>
    expect(resolveFixture("CO", "medellin")).toMatchObject({
      key: "co-c1003654",
      level: "city",
      country: "CO",
      name: "Medellín",
      regionName: "Antioquia",
      center: { lat: 6.246631, lng: -75.581775 },
      dataforseo: { locationCode: 1003654, level: "city", label: "Medellín" },
      enrichment: { divipola: { municipalityCode: "05001", departmentCode: "05" } },
    }));

  test("homonym municipality resolves by department", () => {
    const barbosa = resolveFixture("CO", "barbosa-antioquia");
    expect(barbosa.enrichment?.divipola.departmentCode).toBe("05");
    expect(barbosa.dataforseo.locationCode).toBe(1029276);
  });

  test('Bogotá D.C. from Places matches DataForSEO "Bogota,Bogota,Colombia"', () =>
    expect(resolveFixture("CO", "bogota")).toMatchObject({
      key: "co-c1003659",
      level: "city",
      dataforseo: { locationCode: 1003659 },
    }));

  test("a card without locality uses administrative_area_level_2 within its department", () =>
    expect(resolveFixture("CO", "no-locality")).toMatchObject({
      level: "city",
      enrichment: { divipola: { municipalityCode: "05615" } },
    }));

  test("a municipality without its own code is declared as its department", () =>
    expect(resolveFixture("CO", "salento")).toMatchObject({
      key: "co-c63690",
      level: "region",
      name: "Salento",
      regionName: "Quindío",
      dataforseo: { locationCode: 21519, level: "region", label: "Quindío" },
    }));

  test("Guadalajara and Madrid resolve to cities; a town without code falls back to its region", () => {
    expect(resolveFixture("MX", "guadalajara").level).toBe("city");
    expect(resolveFixture("ES", "madrid").level).toBe("city");
    expect(resolveFixture("MX", "mx-town-without-code")).toMatchObject({
      key: "mx-r20708",
      level: "region",
      name: "Jalisco",
      regionName: null,
      dataforseo: { locationCode: 20708, level: "region", label: "Jalisco" },
    });
  });

  test("a city is asked from its own centroid, never from the business", () => {
    const guadalajara = resolveFixture("MX", "guadalajara", true);
    expect(guadalajara.center).toEqual({
      lat: 20.67738,
      lng: -103.34749,
      level: "city",
      label: "Guadalajara",
    });
    // Captures rebuild the target from its key, so it must not depend on the business.
    expect(guadalajara).toEqual(getGeo("mx-c9047210"));
  });

  test("a town no source locates borrows its region's centroid, labelled as the region", () =>
    expect(getGeo("es-c1005451")).toMatchObject({
      key: "es-c1005451",
      level: "city",
      name: "Corrales del Vino",
      center: { lat: 41.66667, lng: -4.25, level: "region", label: "Castilla y León" },
    }));

  test("a town no source locates, in no located region, has no centroid", () =>
    expect(getGeo("ch-c1002840").center).toBeNull());

  test("a homonym in another region is never taken: the business region wins", () =>
    expect(
      resolveGeo({
        country: "CO" as CountryCode,
        addressComponents: [
          { longText: "Medellín", shortText: "Medellín", types: ["locality", "political"] },
          { longText: "Risaralda", shortText: "RIS", types: ["administrative_area_level_1"] },
        ],
      }),
    ).toMatchObject({ key: "co-r20208", level: "region", name: "Risaralda" }));

  test("homonyms without a known region are not guessed", () =>
    expect(
      resolveGeo({
        country: "CO" as CountryCode,
        addressComponents: [
          { longText: "Barbosa", shortText: "Barbosa", types: ["locality", "political"] },
        ],
      }),
    ).toMatchObject({ key: "co", level: "country" }));

  test("homonyms without a known region take the nearest centroid to the business", () =>
    expect(
      resolveGeo({
        country: "CO" as CountryCode,
        addressComponents: [
          { longText: "Barbosa", shortText: "Barbosa", types: ["locality", "political"] },
        ],
        location: { lat: 5.93, lng: -73.61 },
      }).enrichment?.divipola.departmentCode,
    ).toBe("68"));

  test("unknown places give the country", () =>
    expect(
      resolveGeo({
        country: "CO" as CountryCode,
        addressComponents: [{ longText: "Gotham", shortText: "Gotham", types: ["locality"] }],
      }),
    ).toMatchObject({ key: "co", level: "country" }));

  test("a non measurable country throws", () =>
    expect(() => resolveGeo({ country: "CU" as CountryCode })).toThrow());

  test("no components gives the country with its DataForSEO code", () =>
    expect(resolveGeo({ country: "CO" as CountryCode })).toMatchObject({
      key: "co",
      level: "country",
      name: "Colombia",
      center: null,
      enrichment: null,
      dataforseo: { locationCode: 2170, level: "country", label: "Colombia" },
    }));

  test("every target carries the hash of its country data", () =>
    expect(resolveFixture("CO", "medellin").geoDataHash).toMatch(/^[0-9a-f]{64}$/));

  test("only the business country file is loaded", () => {
    resolveGeo({ country: "CO" as CountryCode });
    expect(loadedCountries()).toEqual(["CO"]);
  });
});

describe("resolveGeo from an address written in the local language", () => {
  const address = (locality: string, region: string): PlacesAddressComponent[] => [
    { longText: locality, shortText: locality, types: ["locality", "political"] },
    { longText: region, shortText: region, types: ["administrative_area_level_1", "political"] },
  ];

  test.each([
    ["DE", "München", "Bayern", "de-c1004234", "Múnich"],
    ["CH", "Genève", "Genève", "ch-c1002992", "Ginebra"],
    ["CH", "Neuchâtel", "Neuchâtel", "ch-c1003088", "Neuchâtel"],
    ["PT", "Lisboa", "Lisboa", "pt-c9198446", "Lisboa"],
    ["US", "New York", "New York", "us-c1023191", "Nueva York"],
    ["GB", "London", "England", "gb-c1006886", "Londres"],
    ["BR", "São Paulo", "São Paulo", "br-c1001773", "São Paulo"],
  ] as const)("%s %s resolves to its city", (country, locality, region, key, name) =>
    expect(resolveGeo({ country, addressComponents: address(locality, region) })).toMatchObject({
      key,
      level: "city",
      name,
    }),
  );
});

describe("resolveGeo in Spanish outside Colombia", () => {
  test.each([
    ["ES", "madrid", "es-c1005493", "Madrid", "Comunidad de Madrid"],
    ["MX", "cdmx", "mx-c1010043", "Ciudad de México", "Ciudad de México"],
    ["MX", "guadalajara", "mx-c9047210", "Guadalajara", "Jalisco"],
    ["AR", "buenos-aires-caba", "ar-c1000073", "Buenos Aires", "Ciudad Autónoma de Buenos Aires"],
    ["CL", "santiago", "cl-c1003325", "Santiago", "Región Metropolitana de Santiago de Chile"],
    ["PE", "lima", "pe-c9073192", "Lima", "Provincia de Lima"],
  ])("%s %s resolves to its city, named in Spanish", (country, name, key, city, region) =>
    expect(resolveFixture(country, name)).toMatchObject({
      key,
      level: "city",
      name: city,
      regionName: region,
      dataforseo: { level: "city", label: city },
    }),
  );

  test.each([
    ["ES", "chinchon", "es-r20282", 20282, "Comunidad de Madrid"],
    ["AR", "capitan-sarmiento", "ar-r20009", 20009, "Provincia de Buenos Aires"],
  ])(
    "%s %s, a town without its own code, falls back to its region by its Spanish name",
    (country, name, key, locationCode, region) =>
      expect(resolveFixture(country, name)).toMatchObject({
        key,
        level: "region",
        name: region,
        dataforseo: { locationCode, level: "region", label: region },
      }),
  );

  test("the province and the autonomous city of Buenos Aires stay apart", () => {
    expect(getGeo("ar-r20010").name).toBe("Ciudad Autónoma de Buenos Aires");
    expect(getGeo("ar-r20009").name).toBe("Provincia de Buenos Aires");
  });
});

describe("geoForEngine", () => {
  test.each([
    ["gemini", "local", {}, { level: "city", label: "Pereira" }],
    ["google-ai-overview", "local", {}, { level: "city", label: "Pereira" }],
    ["google-ai-mode", "local", {}, { level: "city", label: "Pereira" }],
    ["perplexity", "local", {}, { level: "country", label: "Colombia" }],
    [
      "chatgpt",
      "local",
      { provider: "brightdata", chatgptCityEffect: "confirmed" },
      { level: "city", label: "Pereira" },
    ],
    [
      "chatgpt",
      "local",
      { provider: "brightdata", chatgptCityEffect: "not_shown" },
      { level: "country", label: "Colombia" },
    ],
    [
      "chatgpt",
      "local",
      { provider: "dataforseo", chatgptCityEffect: "confirmed" },
      { level: "country", label: "Colombia" },
    ],
    ["chatgpt", "local", { provider: "brightdata" }, { level: "country", label: "Colombia" }],
    ["chatgpt", "local", { provider: "openai" }, { level: "city", label: "Pereira" }],
    ["chatgpt", "national", { provider: "openai" }, { level: "country", label: "Colombia" }],
    ["gemini", "national", {}, { level: "country", label: "Colombia" }],
    ["google-ai-overview", "national", {}, { level: "country", label: "Colombia" }],
    ["google-ai-mode", "national", {}, { level: "country", label: "Colombia" }],
  ] as const)("%s %s %o → %o", (engine, scope, opts, expected) =>
    expect(geoForEngine(engine, resolveFixture("CO", "pereira"), scope, opts)).toEqual(expected),
  );

  test("Salento: Google engines say Quindío, Gemini keeps the municipality", () => {
    const salento = resolveFixture("CO", "salento");
    expect(geoForEngine("google-ai-overview", salento, "local")).toEqual({
      level: "region",
      label: "Quindío",
    });
    expect(geoForEngine("google-ai-mode", salento, "local")).toEqual({
      level: "region",
      label: "Quindío",
    });
    expect(geoForEngine("gemini", salento, "local")).toEqual({ level: "city", label: "Salento" });
  });

  test.each([
    ["es-c1005493", "Madrid"],
    ["es-c9214622", "Barcelona"],
    ["us-c1015116", "Miami"],
    ["mx-c1010043", "Ciudad de México"],
    ["ar-c1000073", "Buenos Aires"],
    ["pe-c9073192", "Lima"],
  ])("Gemini in %s is declared by the city, %s", (key, label) =>
    expect(geoForEngine("gemini", getGeo(key), "local")).toEqual({ level: "city", label }),
  );

  test("Gemini in a town no source locates is declared by the region it is asked from", () =>
    expect(geoForEngine("gemini", getGeo("es-c1005451"), "local")).toEqual({
      level: "region",
      label: "Castilla y León",
    }));

  test("Gemini without a coordinate is declared by country", () =>
    expect(geoForEngine("gemini", getGeo("ch-c1002840"), "local")).toEqual({
      level: "country",
      label: getGeo("ch").name,
    }));

  test("a region target is asked by Gemini from the region's point", () =>
    expect(geoForEngine("gemini", resolveFixture("MX", "mx-town-without-code"), "local")).toEqual({
      level: "region",
      label: "Jalisco",
    }));

  test("ChatGPT is only ever asked by city from the city's own centroid", () =>
    expect(
      geoForEngine("chatgpt", getGeo("es-c1005451"), "local", {
        provider: "brightdata",
        chatgptCityEffect: "confirmed",
      }),
    ).toEqual({ level: "country", label: "España" }));

  test("the ChatGPT control API declares a region target by its region", () =>
    expect(geoForEngine("chatgpt", getGeo("co-r20198"), "local", { provider: "openai" })).toEqual({
      level: "region",
      label: "Antioquia",
    }));

  test("Venezuela has no chatgpt", () =>
    expect(geoForEngine("chatgpt", resolveFixture("VE", "caracas"), "local")).toBeNull());
});

describe("getGeo", () => {
  test("a bare country code is the country-level target", () =>
    expect(getGeo("mx")).toMatchObject({ key: "mx", level: "country", country: "MX" }));

  test("a city key gives the same target as resolving it", () =>
    expect(getGeo("co-c1003654")).toEqual(resolveFixture("CO", "medellin")));

  test("a region key gives the region", () =>
    expect(getGeo("mx-r20708")).toMatchObject({ level: "region", name: "Jalisco" }));

  test.each(["co-c1", "cu", "zz-c1", "not a key"])("%s is not found", (key) => {
    let thrown: unknown;
    try {
      getGeo(key);
    } catch (error) {
      thrown = error;
    }
    expect(isAppError(thrown) && thrown.code).toBe("not_found");
  });
});

describe("cityDisplayName", () => {
  test.each([
    ["CO", "medellin", "Medellín"],
    ["CO", "Bogota", "Bogotá"],
    ["CO", "BOGOTÁ, D.C.", "Bogotá"],
    ["MX", "guadalajara", "Guadalajara"],
    ["MX", "Mexico City", "Ciudad de México"],
    ["ES", "A Coruna", "A Coruña"],
    ["CO", "Gotham", null],
    ["CU", "La Habana", null],
  ])("cityDisplayName(%s, %s) → %s", (country, name, expected) =>
    expect(cityDisplayName(country as CountryCode, name)).toBe(expected),
  );

  test("loads only the names index", () => {
    cityDisplayName("CO" as CountryCode, "cali");
    expect(loadedCountries()).toEqual([]);
  });
});

describe("spokenPlaceName", () => {
  test.each([
    ["Bogotá, D.C.", "Bogotá"],
    ["Bogotá,  D. C.", "Bogotá"],
    ["Washington D.C.", "Washington"],
    ["Medellín", "Medellín"],
    ["Bogotá,D.C.", "Bogotá,D.C."],
    ["D.C.", "D.C."],
  ])("%s → %s", (name, expected) => expect(spokenPlaceName(name)).toBe(expected));

  test("stays linear on long runs of spaces", () => {
    const start = performance.now();
    spokenPlaceName(`${" ".repeat(100_000)}D.${" ".repeat(100_000)}x`);
    expect(performance.now() - start).toBeLessThan(50);
  });
});

describe("chatgptCityEffect", () => {
  const baseline = (content: string) => {
    const file = join(mkdtempSync(join(tmpdir(), "baseline-")), "baseline.json");
    writeFileSync(file, content);
    return pathToFileURL(file);
  };

  test("reads a confirmed effect from the baseline", () =>
    expect(readChatgptCityEffect(baseline('{"version":1,"chatgptCityEffect":"confirmed"}'))).toBe(
      "confirmed",
    ));

  test.each([
    ['{"version":1,"chatgptCityEffect":"not_shown"}'],
    ['{"version":1}'],
    ['{"version":1,"chatgptCityEffect":"maybe"}'],
  ])("anything but a confirmed effect is not shown: %s", (content) =>
    expect(readChatgptCityEffect(baseline(content))).toBe("not_shown"),
  );

  test("a corrupt baseline fails loudly", () =>
    expect(() => readChatgptCityEffect(baseline("{"))).toThrow(SyntaxError));

  test("a missing baseline is not shown", () =>
    expect(readChatgptCityEffect(new URL("file:///nonexistent/baseline.json"))).toBe("not_shown"));
});
