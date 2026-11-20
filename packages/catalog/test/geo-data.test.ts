import { readdirSync, readFileSync, statSync } from "node:fs";
import { measurableCountries } from "@reranker/i18n/countries";
import { describe, expect, test } from "vitest";
import { cityNames } from "../scripts/build-geo.ts";
import {
  expandGeoFile,
  GEO_DATA_VERSION,
  type GeoFile,
  type GeoNamesFile,
} from "../src/geo/format.ts";
import { contentHash } from "../src/hash.ts";

const dir = new URL("../data/geo/", import.meta.url);
const path = (name: string) => new URL(name, dir);
const read = <T>(name: string): T => JSON.parse(readFileSync(path(name), "utf8"));

const manifest = read<{ version: string; geoDataHash: Record<string, string> }>("manifest.json");
const codes = measurableCountries().map((country) => country.code.toLowerCase());
const geoFile = (code: string) => `${code}-${GEO_DATA_VERSION}.json`;

const MAX_COUNTRY_BYTES = 1.2 * 1024 * 1024;
const MAX_NAMES_BYTES = 300 * 1024;

describe("generated location data", () => {
  test("one file per measurable country and none for unmeasured ones", () => {
    const files = readdirSync(dir).filter((name) => name.endsWith(`-${GEO_DATA_VERSION}.json`));
    expect(files.sort()).toEqual(codes.map(geoFile).sort());
    expect(files).not.toContain(geoFile("cu"));
    expect(Object.keys(manifest.geoDataHash).sort()).toEqual(files.sort());
  });

  test.each(codes)("%s matches its manifest hash and size budget", (code) => {
    const file = read<GeoFile>(geoFile(code));
    expect(file).toMatchObject({ version: GEO_DATA_VERSION, country: code.toUpperCase() });
    const hash = contentHash(expandGeoFile(file));
    expect(file.geoDataHash).toBe(hash);
    expect(manifest.geoDataHash[geoFile(code)]).toBe(hash);
    expect(statSync(path(geoFile(code))).size).toBeLessThanOrEqual(MAX_COUNTRY_BYTES);
  });

  test.each(codes)("%s names index lists exactly its cities", (code) => {
    const names = read<GeoNamesFile>(`${code}-names.json`);
    const { cities } = read<GeoFile>(geoFile(code));
    expect(names.country).toBe(code.toUpperCase());
    expect(names.names).toEqual(cityNames(cities));
    expect(names.names).toHaveLength(new Set(cities.map((row) => row[1])).size);
    expect(statSync(path(`${code}-names.json`)).size).toBeLessThanOrEqual(MAX_NAMES_BYTES);
  });

  test("Colombia carries all 1,122 DIVIPOLA records with unique keys", () => {
    const places = expandGeoFile(read<GeoFile>(geoFile("co")));
    const municipalities = places.filter((place) => place.divipola);
    expect(municipalities).toHaveLength(1122);
    expect(new Set(municipalities.map((p) => p.divipola?.municipalityCode)).size).toBe(1122);
    expect(new Set(places.map((place) => place.key)).size).toBe(places.length);
  });

  test("every centroid is a point on Earth, and most cities have their own", () => {
    let cities = 0;
    let located = 0;
    for (const code of codes) {
      const places = expandGeoFile(read<GeoFile>(geoFile(code)));
      const invalid = places.filter(
        ({ center }) => center !== null && (Math.abs(center[0]) > 90 || Math.abs(center[1]) > 180),
      );
      expect(invalid.map((place) => place.key)).toEqual([]);
      const own = places.filter((place) => place.key.includes("-c"));
      cities += own.length;
      located += own.filter((place) => place.center !== null).length;
    }
    // 87.7% when GeoNames' 2026-11-20 dumps were read; a drop means the pairing regressed.
    expect(located / cities).toBeGreaterThan(0.85);
  });

  test("every key is unique and well formed in every country", () => {
    for (const code of codes) {
      const places = expandGeoFile(read<GeoFile>(geoFile(code)));
      expect(new Set(places.map((place) => place.key)).size).toBe(places.length);
      // One assertion per country: an expect per place (~100k) alone outlasts the test timeout on CI.
      const malformed = places.filter((place) => !/^[a-z]{2}-[rc][0-9a-z]+$/.test(place.key));
      expect(malformed.map((place) => place.key)).toEqual([]);
    }
  });
});
