import { type CountryCode, getCountry, isMeasurable } from "@reranker/i18n/countries";
import { AppError } from "@reranker/schema";
import { GeoKey, type GeoTarget, type PlacesAddressComponent } from "@reranker/schema/measurement";
import type { GeoPlace, PlaceLanguage } from "./format";
import { type CountryGeo, loadCityNames, loadCountryGeo } from "./load";
import { normalizePlaceName } from "./normalize";

type LatLng = { lat: number; lng: number };

export type ResolveGeoInput = {
  country: CountryCode;
  addressComponents?: PlacesAddressComponent[];
  location?: LatLng;
};

// The official name of a capital district carries its legal designation ("Bogotá, D.C."),
// which people leave out when they name the city. Anchored on "D." so the match stays linear.
const CAPITAL_DISTRICT = /D\.\s*C\.$/;

const isRegionPlace = (place: GeoPlace) => place.key.includes("-r");

/** Places found under their own name outrank those found under an alias. */
function named(geo: CountryGeo, name: string, keep: (place: GeoPlace) => boolean): GeoPlace[] {
  const normalized = normalizePlaceName(name);
  const found = (geo.byName.get(normalized) ?? []).filter(keep);
  const own = found.filter((place) => place.normalized === normalized);
  return own.length ? own : found;
}

/** Where the business is, as precisely as the engines can be targeted; the country if unknown. */
export function resolveGeo(input: ResolveGeoInput): GeoTarget {
  getCountry(input.country);
  const geo = loadCountryGeo(input.country);
  const components = input.addressComponents ?? [];
  const text = (type: string) => components.find((c) => c.types.includes(type))?.longText;

  const regions = matchRegions(geo, [
    text("administrative_area_level_1"),
    text("administrative_area_level_2"),
  ]);
  const cityName = text("locality") ?? text("administrative_area_level_2");
  const city = cityName && findCity(geo, cityName, regions, input.location);
  if (city) return placeTarget(input.country, geo, city);

  const region = regions.length === 1 ? regions[0] : undefined;
  if (region) return placeTarget(input.country, geo, region);
  return countryTarget(input.country, geo);
}

/** The regions a card's own administrative areas name, the most general level first. */
function matchRegions(geo: CountryGeo, names: readonly (string | undefined)[]): GeoPlace[] {
  for (const name of names) {
    if (!name) continue;
    const found = named(geo, name, isRegionPlace);
    if (found.length) return found;
  }
  return [];
}

// A name shared by several municipalities is never settled by taking the first match: the
// business region decides, else the nearest centroid, else the city is left out.
function findCity(
  geo: CountryGeo,
  name: string,
  regions: readonly GeoPlace[],
  location: LatLng | undefined,
): GeoPlace | undefined {
  const regionKeys = new Set(regions.map((region) => region.key));
  const candidates = named(
    geo,
    name,
    (place) =>
      !isRegionPlace(place) &&
      (regionKeys.size === 0 || (place.regionKey !== null && regionKeys.has(place.regionKey))),
  );
  if (candidates.length <= 1) return candidates[0];
  return location ? nearest(candidates, location) : undefined;
}

function nearest(places: readonly GeoPlace[], { lat, lng }: LatLng): GeoPlace | undefined {
  let best: { place: GeoPlace; distance: number } | undefined;
  const scale = Math.cos((lat * Math.PI) / 180);
  for (const place of places) {
    if (!place.center) return undefined;
    const [placeLat, placeLng] = place.center;
    const distance = (placeLat - lat) ** 2 + ((placeLng - lng) * scale) ** 2;
    if (!best || distance < best.distance) best = { place, distance };
  }
  return best?.place;
}

// Built from the place alone, never from the business's own coordinate: captures rebuild the
// target from its key, and must ask from the same point the report declares.
function placeTarget(country: CountryCode, geo: CountryGeo, place: GeoPlace): GeoTarget {
  const region = place.regionKey === null ? undefined : geo.byKey.get(place.regionKey);
  const declared = place.level === "city" || !region ? place : region;
  return {
    key: place.key,
    level: place.level,
    country,
    name: place.name,
    regionName: region?.name ?? null,
    center: centerOf(place, region),
    dataforseo: { locationCode: place.locationCode, level: place.level, label: declared.name },
    enrichment: place.divipola ? { divipola: place.divipola } : null,
    geoDataHash: geo.geoDataHash,
  };
}

/** The place's own centroid, else its region's, named after the place it belongs to. */
function centerOf(place: GeoPlace, region: GeoPlace | undefined): GeoTarget["center"] {
  const owner = place.center ? place : region?.center ? region : undefined;
  if (!owner?.center) return null;
  const [lat, lng] = owner.center;
  // A municipality is its own place even where the engines only know its region.
  const level = owner.key.includes("-c") ? "city" : "region";
  return { lat, lng, level, label: owner.name };
}

function countryTarget(code: CountryCode, geo: CountryGeo): GeoTarget {
  const country = getCountry(code);
  return {
    key: code.toLowerCase(),
    level: "country",
    country: code,
    name: country.name,
    regionName: null,
    center: null,
    dataforseo: {
      locationCode: country.providers.dataforseo.locationCode,
      level: "country",
      label: country.name,
    },
    enrichment: null,
    geoDataHash: geo.geoDataHash,
  };
}

/** The target behind a stored key; throws `not_found` for keys outside the location data. */
export function getGeo(key: GeoKey): GeoTarget {
  const country = key.slice(0, 2).toUpperCase();
  if (!GeoKey.safeParse(key).success || !isMeasurable(country)) throw notFound(key);
  const geo = loadCountryGeo(country);
  if (key === country.toLowerCase()) return countryTarget(country, geo);
  const place = geo.byKey.get(key);
  if (!place) throw notFound(key);
  return placeTarget(country, geo, place);
}

const notFound = (key: string) => new AppError("not_found", { detail: `unknown geo key ${key}` });

/** The official spelling of a city the visitor's request names, without loading the full data. */
export function cityDisplayName(country: CountryCode, name: string): string | null {
  if (!isMeasurable(country)) return null;
  const found = loadCityNames(country).get(normalizePlaceName(name));
  return found === undefined ? null : spokenPlaceName(found);
}

/** The target's city or region as people who speak `language` write it; null without names in it. */
export function localPlaceName(target: GeoTarget, language: PlaceLanguage): string | null {
  const geo = loadCountryGeo(target.country);
  const place = geo.byKey.get(target.key);
  if (!place || !geo.languages.has(language)) return null;
  return spokenPlaceName(place.names?.[language] ?? place.name);
}

/** The article the target's name takes in `language`, where it takes one. */
export function localPlaceArticle(target: GeoTarget, language: PlaceLanguage): string | undefined {
  return loadCountryGeo(target.country).byKey.get(target.key)?.articles?.[language];
}

/** A place name as people say it, for questions and headings. */
export function spokenPlaceName(name: string): string {
  const designation = CAPITAL_DISTRICT.exec(name);
  if (!designation) return name;
  const before = name.slice(0, designation.index);
  const head = before.trimEnd();
  // "Bogotá, D.C." and "Washington D.C." drop it; a name that merely ends in "D.C." keeps it.
  if (head.length === before.length) return name;
  return head.endsWith(",") ? head.slice(0, -1) : head;
}

/** The wider targets a place falls back to when it has too little data, nearest first. */
export function widerGeos(target: GeoTarget): GeoTarget[] {
  if (target.level === "country") return [];
  const geo = loadCountryGeo(target.country);
  const regionKey = geo.byKey.get(target.key)?.regionKey ?? null;
  const region = target.level === "city" && regionKey !== null ? geo.byKey.get(regionKey) : null;
  const country = countryTarget(target.country, geo);
  return region ? [placeTarget(target.country, geo, region), country] : [country];
}
