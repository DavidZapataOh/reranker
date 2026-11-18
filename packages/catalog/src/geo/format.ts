import { normalizePlaceName } from "./normalize";

export const GEO_DATA_VERSION = "2026.11";

export type GeoPlace = {
  key: string;
  level: "city" | "region";
  name: string;
  normalized: string;
  regionKey: string | null;
  locationCode: number;
  center: [lat: number, lng: number] | null;
  divipola?: { municipalityCode: string; departmentCode: string };
};

export type RegionRow = [locationCode: number, name: string];

/**
 * A null location code marks a municipality the engines cannot target on its own: it is
 * declared as its region while keeping its own name and centroid.
 */
export type CityRow =
  | [locationCode: number, name: string, region: number | null]
  | [
      locationCode: number | null,
      name: string,
      region: number | null,
      center: [lat: number, lng: number] | null,
      municipalityCode: string,
    ];

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
};

/** Display names of every city, for lookups that must not load the full country file. */
export type GeoNamesFile = {
  version: typeof GEO_DATA_VERSION;
  country: string;
  names: string[];
};

const DEPARTMENT_CODE_LENGTH = 2;

export function expandGeoFile(file: Pick<GeoFile, "country" | "regions" | "cities">): GeoPlace[] {
  const prefix = file.country.toLowerCase();
  const regionKey = (code: number) => `${prefix}-r${code}`;

  const regions = file.regions.map(
    ([locationCode, name]): GeoPlace => ({
      key: regionKey(locationCode),
      level: "region",
      name,
      normalized: normalizePlaceName(name),
      regionKey: null,
      locationCode,
      center: null,
    }),
  );

  const cities = file.cities.map((row): GeoPlace => {
    const [code, name, regionIndex, center = null, municipalityCode] = row;
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
