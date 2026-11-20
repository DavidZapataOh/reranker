import { MeasurementLanguage } from "@reranker/schema/measurement";
import { normalizePlaceName } from "./normalize";

export const GEO_DATA_VERSION = "2026.11";

export type Coordinate = [lat: number, lng: number];

/** Every measurement language but Spanish, the language of display names. */
export type PlaceLanguage = Exclude<MeasurementLanguage, "es">;
export const PLACE_LANGUAGES = MeasurementLanguage.options.filter(
  (language): language is PlaceLanguage => language !== "es",
);

/** Location code → the place's name in a language, only where it differs from its display name. */
export type PlaceNames = Record<PlaceLanguage, Record<string, string>>;

export type GeoPlace = {
  key: string;
  level: "city" | "region";
  name: string;
  normalized: string;
  /** Other names the place goes by: matched like its name, never displayed. */
  aliases?: string[];
  /** The name in the languages it differs from `name` in. */
  names?: Partial<Record<PlaceLanguage, string>>;
  /** The definite article the name takes in a language ("o" for Rio de Janeiro in Portuguese). */
  articles?: Partial<Record<PlaceLanguage, string>>;
  regionKey: string | null;
  locationCode: number;
  /** The place's own centroid; null when no source locates it confidently. */
  center: Coordinate | null;
  divipola?: { municipalityCode: string; departmentCode: string };
};

export type RegionRow =
  | [locationCode: number, name: string, center: Coordinate | null]
  | [locationCode: number, name: string, center: Coordinate | null, aliases: string[]];

/**
 * A null location code marks a municipality the engines cannot target on its own: it is
 * declared as its region while keeping its own name and centroid.
 */
export type CityRow =
  | [locationCode: number, name: string, region: number | null, center: Coordinate | null]
  | [
      locationCode: number,
      name: string,
      region: number | null,
      center: Coordinate | null,
      aliases: string[],
    ]
  | [
      locationCode: number | null,
      name: string,
      region: number | null,
      center: Coordinate | null,
      municipalityCode: string,
    ];

/** The aliases of a city row; DIVIPOLA rows carry a municipality code in their place. */
export const cityAliases = (row: CityRow): readonly string[] =>
  Array.isArray(row[4]) ? row[4] : [];

/**
 * Rows instead of GeoPlace objects keep the largest country (21,599 US cities) under the
 * per-country size budget; keys and normalized names are derived on load.
 */
export type GeoFile = {
  version: typeof GEO_DATA_VERSION;
  country: string;
  geoDataHash: string;
  regions: RegionRow[];
  cities: CityRow[];
  names: PlaceNames;
  /** Location code → the article the place's name takes, in the languages that write one. */
  articles: Partial<PlaceNames>;
};

/** A city's display name, alone or followed by its aliases. */
export type CityName = string | [name: string, ...aliases: string[]];

/** Names of every city, for lookups that must not load the full country file. */
export type GeoNamesFile = {
  version: typeof GEO_DATA_VERSION;
  country: string;
  names: CityName[];
};

const DEPARTMENT_CODE_LENGTH = 2;

export function expandGeoFile(
  file: Pick<GeoFile, "country" | "regions" | "cities"> & {
    names?: PlaceNames;
    articles?: GeoFile["articles"];
  },
): GeoPlace[] {
  const prefix = file.country.toLowerCase();
  const regionKey = (code: number) => `${prefix}-r${code}`;
  const byLanguage = (table: Partial<PlaceNames> | undefined, code: number | null) =>
    PLACE_LANGUAGES.flatMap((language) => {
      const value = code === null ? undefined : table?.[language]?.[code];
      return value === undefined ? [] : [[language, value] as const];
    });
  const namesOf = (code: number | null) => {
    const names = byLanguage(file.names, code);
    const articles = byLanguage(file.articles, code);
    return {
      ...(names.length ? { names: Object.fromEntries(names) } : {}),
      ...(articles.length ? { articles: Object.fromEntries(articles) } : {}),
    };
  };

  const regions = file.regions.map(
    ([locationCode, name, center, aliases]): GeoPlace => ({
      key: regionKey(locationCode),
      level: "region",
      name,
      normalized: normalizePlaceName(name),
      ...(aliases ? { aliases } : {}),
      ...namesOf(locationCode),
      regionKey: null,
      locationCode,
      center,
    }),
  );

  const cities = file.cities.map((row): GeoPlace => {
    const [code, name, regionIndex, center, extra] = row;
    const municipalityCode = typeof extra === "string" ? extra : undefined;
    const aliases = Array.isArray(extra) ? extra : undefined;
    const region = regionIndex === null ? undefined : file.regions[regionIndex];
    if (regionIndex !== null && region === undefined) {
      throw new RangeError(`${name} points at missing region ${regionIndex}`);
    }
    const ownCode = code ?? region?.[0];
    if (ownCode === undefined) throw new RangeError(`${name} has no location code`);
    return {
      key: `${prefix}-c${code ?? municipalityCode}`,
      level: code === null ? "region" : "city",
      name,
      normalized: normalizePlaceName(name),
      ...(aliases ? { aliases } : {}),
      ...namesOf(code),
      regionKey: region ? regionKey(region[0]) : null,
      locationCode: ownCode,
      center,
      ...(municipalityCode === undefined
        ? {}
        : {
            divipola: {
              municipalityCode,
              departmentCode: municipalityCode.slice(0, DEPARTMENT_CODE_LENGTH),
            },
          }),
    };
  });

  return [...regions, ...cities].sort((a, b) => compareKeys(a.key, b.key));
}

export function compareKeys(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
