import { readFileSync } from "node:fs";
import type { CountryCode } from "@reranker/i18n/countries";
import {
  expandGeoFile,
  GEO_DATA_VERSION,
  type GeoFile,
  type GeoNamesFile,
  type GeoPlace,
} from "./format";
import { normalizePlaceName } from "./normalize";

export type CountryGeo = {
  readonly geoDataHash: string;
  readonly byKey: ReadonlyMap<string, GeoPlace>;
  readonly byName: ReadonlyMap<string, readonly GeoPlace[]>;
};

const dataFile = (name: string) => new URL(`../../data/geo/${name}`, import.meta.url);
const readJson = <T>(name: string): T => JSON.parse(readFileSync(dataFile(name), "utf8")) as T;

// One file per country keeps a process at a single country's data in memory.
const countries = new Map<string, CountryGeo>();
const cityNames = new Map<string, ReadonlyMap<string, string>>();

export function loadCountryGeo(country: CountryCode): CountryGeo {
  const cached = countries.get(country);
  if (cached) return cached;
  const file = readJson<GeoFile>(`${country.toLowerCase()}-${GEO_DATA_VERSION}.json`);
  const places = expandGeoFile(file);
  const byName = new Map<string, GeoPlace[]>();
  for (const place of places) {
    const names = new Set([place.normalized, ...(place.aliases ?? []).map(normalizePlaceName)]);
    for (const name of names) {
      const named = byName.get(name);
      if (named) named.push(place);
      else byName.set(name, [place]);
    }
  }
  const geo: CountryGeo = {
    geoDataHash: file.geoDataHash,
    byKey: new Map(places.map((place) => [place.key, place])),
    byName,
  };
  countries.set(country, geo);
  return geo;
}

/** Normalized city name → display name, from the light index the landing can afford. */
export function loadCityNames(country: CountryCode): ReadonlyMap<string, string> {
  const cached = cityNames.get(country);
  if (cached) return cached;
  const { names } = readJson<GeoNamesFile>(`${country.toLowerCase()}-names.json`);
  const entries = names.map((entry): [string, ...string[]] =>
    typeof entry === "string" ? [entry] : entry,
  );
  const index = new Map<string, string>();
  const add = (written: string, name: string) => {
    const normalized = normalizePlaceName(written);
    if (!index.has(normalized)) index.set(normalized, name);
  };
  // Display names first, so an alias never hides another city's own name.
  for (const [name] of entries) add(name, name);
  for (const [name, ...aliases] of entries) for (const alias of aliases) add(alias, name);
  cityNames.set(country, index);
  return index;
}

export function loadedCountries(): string[] {
  return [...countries.keys()];
}

export function resetGeoCache(): void {
  countries.clear();
  cityNames.clear();
}
