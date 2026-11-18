import { readFileSync } from "node:fs";
import { parse } from "csv-parse/sync";
import { describe, expect, test } from "vitest";
import { buildCountry, CSV_OPTIONS, cityNames, type LocationRow } from "../scripts/build-geo.ts";
import { type GeoNamesEntry, geoNamesCollector, spanishNames } from "../scripts/geonames.ts";
import { expandGeoFile, type GeoPlace } from "../src/geo/format.ts";

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

describe("spanishNames", () => {
  const london: GeoNamesEntry = {
    id: 2643743,
    kind: "place",
    admin1: "ENG",
    admin2: "GLA",
    name: "London",
    asciiName: "London",
    population: 8961989,
    alternates: [
      { id: 1, name: "London", lang: "en", preferred: true, short: false },
      { id: 2, name: "Londres", lang: "es", preferred: true, short: false },
    ],
  };
  const cities = (name: string) =>
    spanishNames(
      { regions: [], cities: [{ code: 1006886, name, region: null }] },
      { spanishSpeaking: false, entries: [london] },
    ).cities;

  test("a city abroad reads in Spanish and keeps its own name as an alias", () =>
    expect(cities("London").get(1006886)).toEqual({
      name: "Londres",
      aliases: ["London"],
      spanish: true,
    }));

  test("a place without a confident pair is left out", () => expect(cities("Gotham").size).toBe(0));
});

describe("cityNames", () => {
  test("lists each display name once, with the aliases of every city shown under it", () =>
    expect(
      cityNames([
        [3, "Ciudad de México", 0, ["Mexico City", "Distrito Federal"]],
        [1, "Guadalajara", 1],
        [2, "Guadalajara", 2],
        [4, "Ciudad de México", 1, ["mexico city"]],
      ]),
    ).toEqual([["Ciudad de México", "Mexico City", "Distrito Federal"], "Guadalajara"]));
});
