// Builds the per-country location tables from DataForSEO's Google locations list.
import { type CityRow, compareKeys, type GeoFile, type RegionRow } from "../src/geo/format.ts";
import { normalizePlaceName } from "../src/geo/normalize.ts";

export type LocationRow = {
  location_code: string;
  location_name: string;
  location_code_parent: string;
  country_iso_code: string;
  location_type: string;
};

export type CountryTables = Pick<GeoFile, "country" | "regions" | "cities">;

export const CSV_OPTIONS = { columns: true, skip_empty_lines: true } as const;

const CITY_TYPES = new Set(["City", "Municipality"]);
// Most preferred first: the first matching ancestor in this order is a city's region.
const REGION_TYPES = [
  "Region",
  "State",
  "Department",
  "Province",
  "Autonomous Community",
  "Governorate",
  "Prefecture",
  "County",
];

const placeName = (row: LocationRow) => row.location_name.split(",")[0]?.trim() ?? "";
const segments = (row: LocationRow) => row.location_name.split(",").length;

/** Shortest "City,Region,Country" form first, then the lowest code, so reruns pick the same row. */
function preferred(a: LocationRow, b: LocationRow): number {
  return segments(a) - segments(b) || Number(a.location_code) - Number(b.location_code);
}

function regionResolver(byCode: ReadonlyMap<string, LocationRow>) {
  return (row: LocationRow): LocationRow | null => {
    let best: LocationRow | null = null;
    const seen = new Set<string>();
    for (
      let parent = byCode.get(row.location_code_parent);
      parent && !seen.has(parent.location_code);
      parent = byCode.get(parent.location_code_parent)
    ) {
      seen.add(parent.location_code);
      const rank = REGION_TYPES.indexOf(parent.location_type);
      if (rank !== -1 && (!best || rank < REGION_TYPES.indexOf(best.location_type))) best = parent;
    }
    return best;
  };
}

function countryOf(rows: readonly LocationRow[]): string {
  const codes = new Set(rows.map((row) => row.country_iso_code));
  const [country] = codes;
  if (codes.size !== 1 || !country) throw new Error(`expected one country, got ${[...codes]}`);
  return country;
}

export function buildCountry(rows: readonly LocationRow[]): CountryTables {
  const country = countryOf(rows);
  const byCode = new Map(rows.map((row) => [row.location_code, row]));
  const regionOf = regionResolver(byCode);
  const cities = rows.filter((row) => CITY_TYPES.has(row.location_type));
  return buildFromLocations(country, rows, cities, regionOf);
}

function buildFromLocations(
  country: string,
  rows: readonly LocationRow[],
  cities: readonly LocationRow[],
  regionOf: (row: LocationRow) => LocationRow | null,
): CountryTables {
  const kept = new Map<string, { row: LocationRow; region: LocationRow | null }>();
  for (const row of cities) {
    const region = regionOf(row);
    const id = `${normalizePlaceName(placeName(row))}|${region?.location_code ?? ""}`;
    const current = kept.get(id);
    if (!current || preferred(row, current.row) < 0) kept.set(id, { row, region });
  }

  // Every top-level region exists even without cities, so a business there still resolves.
  const topType = REGION_TYPES.find((type) => rows.some((row) => row.location_type === type));
  const regionRows = new Map(
    rows.filter((row) => row.location_type === topType).map((row) => [row.location_code, row]),
  );
  for (const { region } of kept.values()) if (region) regionRows.set(region.location_code, region);

  const regions = [...regionRows.values()]
    .map((row): RegionRow => [Number(row.location_code), placeName(row)])
    .sort((a, b) => a[0] - b[0]);
  const regionIndex = new Map(regions.map(([code], index) => [String(code), index]));

  return {
    country,
    regions,
    cities: [...kept.values()]
      .map(
        ({ row, region }): CityRow => [
          Number(row.location_code),
          placeName(row),
          region ? (regionIndex.get(region.location_code) ?? null) : null,
        ],
      )
      .sort((a, b) => compareKeys(String(a[0]), String(b[0]))),
  };
}
