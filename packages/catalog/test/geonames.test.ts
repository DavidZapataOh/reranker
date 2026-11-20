import { readFileSync } from "node:fs";
import { parse } from "csv-parse/sync";
import { describe, expect, test } from "vitest";
import { buildCountry, CSV_OPTIONS, cityNames, type LocationRow } from "../scripts/build-geo.ts";
import { type GeoNamesEntry, geoNamesCollector, pairGeoNames } from "../scripts/geonames.ts";
import { type Coordinate, expandGeoFile, type GeoPlace } from "../src/geo/format.ts";

// Recorded extracts of DataForSEO's locations CSV and of the GeoNames dumps for these places.
const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/geo/${name}`, import.meta.url), "utf8");
const locations: LocationRow[] = parse(fixture("locations-es-mx-ar-cl-pe.csv"), CSV_OPTIONS);
const COUNTRIES = ["ES", "MX", "AR", "CL", "PE"];
const rowsOf = (country: string) => locations.filter((row) => row.country_iso_code === country);

function geonames(reversed = false) {
  const lines = (name: string) => {
    const all = fixture(`geonames-${name}`).split("\n").filter(Boolean);
    return reversed ? all.reverse() : all;
  };
  const collector = geoNamesCollector(new Set(COUNTRIES));
  for (const line of lines("admin1CodesASCII.txt")) collector.area(line, "adm1");
  for (const line of lines("admin2Codes.txt")) collector.area(line, "adm2");
  for (const line of lines("cities500.txt")) collector.place(line);
  for (const line of lines("countryInfo.txt")) collector.country(line);
  for (const line of lines("alternateNamesV2.txt")) collector.alternate(line);
  for (const line of lines("allCountries.txt")) collector.gazetteer(line);
  return collector.done();
}

const forCountry = geonames();
const named = (country: string) => buildCountry(rowsOf(country), { geonames: forCountry(country) });
const place = (key: string): GeoPlace => {
  const found = expandGeoFile(named(key.slice(0, 2).toUpperCase())).find((p) => p.key === key);
  if (!found) throw new Error(`no place ${key}`);
  return found;
};

describe("Spanish names from GeoNames", () => {
  test.each([
    ["es-r20282", "Comunidad de Madrid", "Community of Madrid"],
    ["es-r9047045", "Provincia de Madrid", "Province of Madrid"],
    ["mx-r20703", "Ciudad de México", "Mexico City"],
    ["mx-c1010043", "Ciudad de México", "Mexico City"],
    ["mx-r20709", "Estado de México", "State of Mexico"],
    ["ar-r20009", "Provincia de Buenos Aires", "Buenos Aires Province"],
    ["ar-r20010", "Ciudad Autónoma de Buenos Aires", "Buenos Aires"],
    ["cl-r20160", "Región Metropolitana de Santiago de Chile", "Región Metropolitana"],
    ["pe-r9189140", "Provincia de Lima", "Lima Province"],
    ["pe-r20808", "Región de Lima", "Lima Region"],
  ])("%s reads %s and is still found as %s", (key, name, alias) => {
    expect(place(key).name).toBe(name);
    expect(place(key).aliases).toContain(alias);
  });

  test.each([
    ["mx-r20708", "Jalisco"],
    ["mx-c1010058", "León"],
    ["es-c9212542", "A Coruña"],
    ["es-c1005493", "Madrid"],
    ["ar-c1000073", "Buenos Aires"],
    ["cl-c1003325", "Santiago"],
    ["pe-c9073192", "Lima"],
  ])("%s keeps its local official name, accents included: %s", (key, name) =>
    expect(place(key).name).toBe(name),
  );

  test.each(COUNTRIES)("%s keeps every DataForSEO code, key and region", (country) => {
    const shape = (places: readonly GeoPlace[]) =>
      places.map(({ key, level, locationCode, regionKey }) => ({
        key,
        level,
        locationCode,
        regionKey,
      }));
    expect(shape(expandGeoFile(named(country)))).toEqual(
      shape(expandGeoFile(buildCountry(rowsOf(country)))),
    );
  });

  test.each(COUNTRIES)("%s: the dumps' row order does not change the output", (country) =>
    expect(buildCountry(rowsOf(country), { geonames: geonames(true)(country) })).toEqual(
      named(country),
    ),
  );

  test("the build reports how many places got a Spanish name", () =>
    expect(named("PE").spanish).toEqual({ regions: 26, cities: 1 }));

  test("historic and colloquial names are never aliases", () => {
    const aliases = place("mx-r20703").aliases;
    for (const name of ["El DF", "DF", "Mexico D.F."]) expect(aliases).not.toContain(name);
  });
});

describe("centroids from GeoNames", () => {
  test.each([
    ["es-c1005493", [40.4165, -3.70256]],
    ["mx-c1010043", [19.42847, -99.12766]],
    ["ar-c1000073", [-34.61315, -58.37723]],
    ["pe-c9073192", [-12.04318, -77.02824]],
    ["cl-c1003325", [-33.45694, -70.64827]],
  ])("%s is located at its GeoNames place", (key, center) =>
    expect(place(key).center).toEqual(center),
  );

  test.each([
    ["es-r20282", [40.42526, -3.69063]],
    ["mx-r20708", [20.33333, -103.66667]],
  ])("%s is located at its area's point in the full gazetteer", (key, center) =>
    expect(place(key).center).toEqual(center),
  );

  test("a region the gazetteer gives no point keeps none", () =>
    expect(place("pe-r20808").center).toBeNull());
});

const entry = (fields: Partial<GeoNamesEntry> & Pick<GeoNamesEntry, "id" | "name">) => ({
  kind: "place" as const,
  admin1: "14",
  admin2: "",
  asciiName: fields.name,
  population: 0,
  center: null,
  alternates: [],
  gazetteerNames: [],
  ...fields,
});

describe("pairGeoNames", () => {
  const london = entry({
    id: 2643743,
    admin1: "ENG",
    admin2: "GLA",
    name: "London",
    population: 8961989,
    center: [51.50853, -0.12574],
    alternates: [
      { id: 1, name: "London", lang: "en", preferred: true, short: false },
      { id: 2, name: "Londres", lang: "es", preferred: true, short: false },
    ],
  });
  const cities = (name: string) =>
    pairGeoNames(
      { regions: [], cities: [{ code: 1006886, name, region: null }] },
      { spanishSpeaking: false, entries: [london], minorPlaces: [] },
    );

  test("a city abroad reads in Spanish and keeps its own name as an alias", () =>
    expect(cities("London").cities.get(1006886)).toMatchObject({
      name: "Londres",
      aliases: ["London"],
      spanish: true,
    }));

  test("each language takes its own name, else the native one, never the Spanish exonym", () =>
    expect(cities("London").cities.get(1006886)).toMatchObject({
      names: { en: "London", pt: "London", fr: "London", de: "London", it: "London" },
      own: ["en"],
    }));

  // Zürich, which DataForSEO lists without its umlaut.
  const zurich = (alternates: GeoNamesEntry["alternates"]) =>
    pairGeoNames(
      { regions: [], cities: [{ code: 1003297, name: "Zurich", region: null }] },
      {
        spanishSpeaking: false,
        entries: [entry({ id: 2657896, admin1: "ZH", name: "Zurich", alternates })],
        minorPlaces: [],
      },
    ).cities.get(1003297)?.names;
  const name = (id: number, lang: string, written: string, flags: object = {}) => ({
    id,
    name: written,
    lang,
    preferred: false,
    short: false,
    ...flags,
  });

  test.each([
    [
      "the preferred name in the language",
      [name(1, "de", "Zuerich"), name(2, "de", "Zürich", { preferred: true })],
      "de",
      "Zürich",
    ],
    [
      "the name DataForSEO lists, with the accents it drops",
      [name(1, "fr", "Zürich"), name(2, "fr", "Zurich")],
      "fr",
      "Zürich",
    ],
    ["any full name in the language", [name(1, "it", "Zurigo")], "it", "Zurigo"],
    [
      "no abbreviation",
      [name(1, "pt", "Z.", { short: true }), name(2, "pt", "Zurique")],
      "pt",
      "Zurique",
    ],
    ["the local name where the language has none", [name(1, "", "Zürich")], "en", "Zürich"],
  ] as const)("%s", (_, alternates, language, expected) =>
    expect(zurich([...alternates])?.[language]).toBe(expected),
  );

  test("a paired city is located at its GeoNames place", () =>
    expect(cities("London").centers.get(1006886)).toEqual([51.50853, -0.12574]));

  test("a place without a confident pair is left out", () => {
    const pairs = cities("Gotham");
    expect(pairs.cities.size).toBe(0);
    expect(pairs.centers.size).toBe(0);
  });

  // GeoNames repeats English names untagged; where Spanish is spoken they never win.
  const english = (id: number, name: string) => [
    { id, name, lang: "", preferred: false, short: false },
    { id: id + 1, name, lang: "en", preferred: true, short: false },
  ];
  const spanishName = (id: number, name: string, preferred = false) => ({
    id,
    name,
    lang: "es",
    preferred,
    short: false,
  });

  const italianOf = (
    country: string,
    fields: Partial<GeoNamesEntry> & Pick<GeoNamesEntry, "id" | "name">,
    italian: string,
    french?: string,
  ) =>
    pairGeoNames(
      { regions: [], cities: [{ code: 1, name: fields.name, region: null }] },
      {
        country,
        spanishSpeaking: false,
        entries: [
          entry({
            ...fields,
            alternates: [
              { id: 1, name: italian, lang: "it", preferred: true, short: false },
              ...(french
                ? [{ id: 2, name: french, lang: "fr", preferred: true, short: false }]
                : []),
            ],
          }),
        ],
        minorPlaces: [],
      },
    ).cities.get(1)?.italian;

  test.each([
    [
      "La Spezia, in Italy",
      "IT",
      { id: 1, admin1: "08", name: "La Spezia" },
      "La Spezia",
      undefined,
      true,
    ],
    [
      "Il Cairo, an exonym",
      "EG",
      { id: 2, admin1: "11", name: "Cairo" },
      "Il Cairo",
      "Le Caire",
      true,
    ],
    [
      "La Magdeleine, in the Aosta Valley",
      "IT",
      { id: 3, admin1: "19", name: "La Magdeleine" },
      "La Magdeleine",
      "La Magdeleine",
      false,
    ],
    [
      "Bolzano, South Tyrol's Italian name",
      "IT",
      { id: 4, admin1: "17", admin2: "BZ", name: "Bozen" },
      "Bolzano",
      undefined,
      true,
    ],
    [
      "La Chaux-de-Fonds, in French Switzerland",
      "CH",
      { id: 5, admin1: "NE", name: "La Chaux-de-Fonds" },
      "La Chaux-de-Fonds",
      undefined,
      false,
    ],
    ["Lugano, in Ticino", "CH", { id: 6, admin1: "TI", name: "Lugano" }, "Lugano", undefined, true],
    [
      "La Cruz de Elota, a Spanish name tagged Italian",
      "MX",
      { id: 7, admin1: "25", name: "La Cruz" },
      "La Cruz de Elota",
      undefined,
      false,
    ],
    [
      "LaBelle, spaced",
      "US",
      { id: 8, admin1: "FL", name: "LaBelle" },
      "La Belle",
      undefined,
      false,
    ],
  ] as const)("%s: Italian name is Italian: %s", (_, country, fields, italian, french, expected) =>
    expect(italianOf(country, { ...fields }, italian, french)).toBe(expected),
  );

  test("an untagged copy of the English name never names a city in Spanish", () => {
    const sevilla = entry({
      id: 2510911,
      admin1: "AN",
      name: "Sevilla",
      alternates: [...english(1, "Seville"), spanishName(3, "Sevilla", true)],
    });
    const pairs = pairGeoNames(
      { regions: [], cities: [{ code: 1005421, name: "Seville", region: null }] },
      { spanishSpeaking: true, entries: [sevilla], minorPlaces: [] },
    );
    expect(pairs.cities.get(1005421)).toMatchObject({ name: "Sevilla", aliases: ["Seville"] });
  });

  test("an area's English name never names it in Spanish", () => {
    const department = entry({
      id: 3837460,
      kind: "adm2",
      admin1: "21",
      admin2: "8435",
      name: "San Jerónimo Department",
      alternates: [
        ...english(1, "San Jerónimo Department"),
        spanishName(3, "Departamento de San Jerónimo"),
        spanishName(4, "San Jerónimo"),
      ],
    });
    const pairs = pairGeoNames(
      { regions: [{ code: 9246111, name: "San Jeronimo Department", level: 2 }], cities: [] },
      { spanishSpeaking: true, entries: [department], minorPlaces: [] },
    );
    expect(pairs.regions.get(9246111)?.name).toBe("Departamento de San Jerónimo");
  });

  // A town DataForSEO lists in Jalisco (state 14), and the GeoNames places that may locate it.
  const JALISCO = 20708;
  const jalisco = entry({ id: 4004156, kind: "adm1", name: "Jalisco", center: [20.3, -103.7] });
  const locate = (name: string, places: GeoNamesEntry[], minorPlaces: GeoNamesEntry[] = []) =>
    pairGeoNames(
      {
        regions: [{ code: JALISCO, name: "Jalisco", level: 1 }],
        cities: [{ code: 1, name, region: JALISCO }],
      },
      { spanishSpeaking: true, entries: [jalisco, ...places], minorPlaces },
    );
  const at = (id: number, name: string, center: Coordinate, more: Partial<GeoNamesEntry> = {}) =>
    entry({ id, name, center, ...more });

  test("the region is located at its area's point", () =>
    expect(locate("Tonalá", []).centers.get(JALISCO)).toEqual([20.3, -103.7]));

  test.each([
    [
      "the most populous of same-named places",
      "Tonalá",
      [at(10, "Tonalá", [20.62, -103.23], { population: 9 }), at(11, "Tonalá", [21.9, -104.9])],
      [],
      [20.62, -103.23],
    ],
    [
      "a place below cities500's threshold",
      "Tecolotlán",
      [],
      [at(12, "Tecolotlán", [20.2, -104.05])],
      [20.2, -104.05],
    ],
    [
      "a name only the gazetteer lists",
      "Tlaquepaque",
      [at(13, "San Pedro Tlaquepaque", [20.64, -103.31], { gazetteerNames: ["tlaquepaque"] })],
      [],
      [20.64, -103.31],
    ],
    [
      "the name without DataForSEO's designator",
      "Municipality of Zapopan",
      [at(14, "Zapopan", [20.72, -103.39])],
      [],
      [20.72, -103.39],
    ],
    [
      "no place: same-named ones with no clear lead",
      "Santa Cruz",
      [at(10, "Santa Cruz", [20.1, -103.1]), at(11, "Santa Cruz", [21.9, -104.9])],
      [],
      undefined,
    ],
    [
      "no place: one in another state",
      "Tonalá",
      [at(15, "Tonalá", [16.1, -93.8], { admin1: "07" })],
      [],
      undefined,
    ],
  ] as const)("%s locates the town", (_, name, places, minor, center) =>
    expect(locate(name, [...places], [...minor]).centers.get(1)).toEqual(center),
  );
});

describe("geoNamesCollector", () => {
  const row = (fields: Record<number, string>) =>
    Array.from({ length: 19 }, (_, index) => fields[index] ?? "").join("\t");

  test("the full gazetteer adds areas' points and the small places named like a listed city", () => {
    const collector = geoNamesCollector(
      new Set(["MX"]),
      new Map([["MX", new Set(["tecolotlan"])]]),
    );
    collector.area("MX.14\tJalisco\tJalisco\t4004156", "adm1");
    collector.place(row({ 0: "10", 1: "Tonalá", 4: "20.62", 5: "-103.23", 8: "MX", 14: "536111" }));
    const place = (id: string, name: string, code: string, country = "MX") =>
      row({ 0: id, 1: name, 2: name, 4: "20.2", 5: "-104.05", 6: "P", 7: code, 8: country });
    for (const line of [
      row({ 0: "4004156", 1: "Estado de Jalisco", 4: "20.33333", 5: "-103.66667", 6: "A" }),
      row({ 0: "10", 1: "Tonalá", 4: "0", 5: "0", 6: "P", 7: "PPLA2", 8: "MX" }),
      place("12", "Tecolotlán", "PPL"),
      place("13", "Tecolotlán", "PPLH"),
      place("14", "Ameca", "PPL"),
      place("15", "Tecolotlán", "PPL", "GT"),
    ]) {
      collector.gazetteer(line);
    }
    const mx = collector.done()("MX");
    expect(mx.entries.map((e) => [e.id, e.center])).toEqual([
      [10, [20.62, -103.23]],
      [4004156, [20.33333, -103.66667]],
    ]);
    expect(mx.minorPlaces.map((e) => e.id)).toEqual([12]);
  });
});

describe("cityNames", () => {
  test("lists each display name once, with the aliases of every city shown under it", () =>
    expect(
      cityNames([
        [3, "Ciudad de México", 0, null, ["Mexico City", "Distrito Federal"]],
        [1, "Guadalajara", 1, null],
        [2, "Guadalajara", 2, null],
        [4, "Ciudad de México", 1, null, ["mexico city"]],
      ]),
    ).toEqual([["Ciudad de México", "Mexico City", "Distrito Federal"], "Guadalajara"]));
});
