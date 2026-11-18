// Rebuilds data/geo from DataForSEO's Google locations list, named in Spanish from GeoNames
// and, for the municipalities of Colombia, from the official DIVIPOLA register.
// Usage: pnpm --filter @reranker/catalog geo:build
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { Readable } from "node:stream";
import { measurableCountries } from "@reranker/i18n/countries";
import { parse } from "csv-parse";
import {
  type CityName,
  type CityRow,
  compareKeys,
  expandGeoFile,
  GEO_DATA_VERSION,
  type GeoFile,
  type GeoNamesFile,
  type RegionRow,
} from "../src/geo/format.ts";
import { normalizePlaceName } from "../src/geo/normalize.ts";
import { contentHash } from "../src/hash.ts";
import { type CountryGeoNames, type Naming, readGeoNames, spanishNames } from "./geonames.ts";

const LOCATIONS_CSV =
  "https://cdn.dataforseo.com/v3/locations/locations_serp_google_2026_11_02.csv";
const DIVIPOLA_JSON = "https://www.datos.gov.co/resource/gdxc-w37w.json?$limit=2000";
const DIVIPOLA_RECORDS = 1122;
// DataForSEO's own label for the country DIVIPOLA covers.
const DIVIPOLA_COUNTRY_NAME = "Colombia";
const OUTPUT = new URL("../data/geo/", import.meta.url);

export type LocationRow = {
  location_code: string;
  location_name: string;
  location_code_parent: string;
  country_iso_code: string;
  location_type: string;
};

export type DivipolaRecord = {
  cod_dpto: string;
  dpto: string;
  cod_mpio: string;
  nom_mpio: string;
  latitud: string;
  longitud: string;
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

// DIVIPOLA department code → DataForSEO region name, where the two names differ.
const DEPARTMENT_ALIASES: Record<string, string> = {
  "54": "North Santander",
  "88": "San Andres and Providencia",
};

// DIVIPOLA municipality code → the common name DataForSEO lists it under, with its accents.
const MUNICIPALITY_ALIASES: Record<string, string> = {
  "13468": "Mompós",
  "76126": "Darién",
};

const PREPOSITIONS = new Set(["de", "del", "en", "y", "e"]);
// An article stays lowercase only after a preposition: "Belén de los Andaquíes", "Castilla La Nueva".
const ARTICLES = new Set(["el", "la", "las", "los"]);

const placeName = (row: LocationRow) => row.location_name.split(",")[0]?.trim() ?? "";
const segments = (row: LocationRow) => row.location_name.split(",").length;
const tokens = (name: string) => normalizePlaceName(name).split(" ").filter(Boolean);

/** DIVIPOLA writes names in capitals; this restores the way they are written in prose. */
export function officialName(upper: string): string {
  return upper
    .toLocaleLowerCase("es")
    .split(/\s+/)
    .filter(Boolean)
    .map((word, index, words) => {
      if (word === "d.c.") return "D.C.";
      if (index > 0 && PREPOSITIONS.has(word)) return word;
      if (ARTICLES.has(word) && PREPOSITIONS.has(words[index - 1] ?? "")) return word;
      return word.replace(
        /(^|[-(])(\p{L})/gu,
        (_, before: string, letter: string) => `${before}${letter.toLocaleUpperCase("es")}`,
      );
    })
    .join(" ");
}

/** Shortest "City,Region,Country" form first, then the lowest code, so reruns pick the same row. */
function preferred(a: LocationRow, b: LocationRow): number {
  return segments(a) - segments(b) || Number(a.location_code) - Number(b.location_code);
}

function indexOf<T>(haystack: readonly T[], needle: readonly T[]): number {
  for (let start = 0; start + needle.length <= haystack.length; start++) {
    if (needle.every((value, offset) => haystack[start + offset] === value)) return start;
  }
  return -1;
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

export type Coverage = { regions: number; cities: number };

export function buildCountry(
  rows: readonly LocationRow[],
  sources: { divipola?: readonly DivipolaRecord[]; geonames?: CountryGeoNames } = {},
): CountryTables & { spanish?: Coverage } {
  const country = countryOf(rows);
  const byCode = new Map(rows.map((row) => [row.location_code, row]));
  const regionOf = regionResolver(byCode);
  const cities = rows.filter((row) => CITY_TYPES.has(row.location_type));
  return sources.divipola
    ? buildFromDivipola(country, rows, cities, regionOf, sources.divipola)
    : buildFromLocations(country, rows, cities, regionOf, sources.geonames);
}

function buildFromLocations(
  country: string,
  rows: readonly LocationRow[],
  cities: readonly LocationRow[],
  regionOf: (row: LocationRow) => LocationRow | null,
  geonames: CountryGeoNames | undefined,
): CountryTables & { spanish?: Coverage } {
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

  const listed = (row: LocationRow) => ({ code: Number(row.location_code), name: placeName(row) });
  const named =
    geonames &&
    spanishNames(
      {
        regions: [...regionRows.values()].map((row) => ({
          ...listed(row),
          level: regionOf(row) ? 2 : 1,
        })),
        cities: [...kept.values()].map(({ row, region }) => ({
          ...listed(row),
          region: region ? Number(region.location_code) : null,
        })),
      },
      geonames,
    );
  const naming = (row: LocationRow, names?: ReadonlyMap<number, Naming>) =>
    names?.get(Number(row.location_code)) ?? { name: placeName(row), aliases: [] };

  const regions = [...regionRows.values()]
    .map((row): RegionRow => {
      const { name, aliases } = naming(row, named?.regions);
      const code = Number(row.location_code);
      return aliases.length ? [code, name, aliases] : [code, name];
    })
    .sort((a, b) => a[0] - b[0]);
  const regionIndex = new Map(regions.map(([code], index) => [String(code), index]));

  return {
    country,
    regions,
    cities: [...kept.values()]
      .map(({ row, region }): CityRow => {
        const { name, aliases } = naming(row, named?.cities);
        const at = region ? (regionIndex.get(region.location_code) ?? null) : null;
        const code = Number(row.location_code);
        return aliases.length ? [code, name, at, aliases] : [code, name, at];
      })
      .sort((a, b) => compareKeys(String(a[0]), String(b[0]))),
    ...(named && {
      spanish: {
        regions: [...named.regions.values()].filter((n) => n.spanish).length,
        cities: [...named.cities.values()].filter((n) => n.spanish).length,
      },
    }),
  };
}

type Match = { row: LocationRow; name: string };

function buildFromDivipola(
  country: string,
  rows: readonly LocationRow[],
  cities: readonly LocationRow[],
  regionOf: (row: LocationRow) => LocationRow | null,
  divipola: readonly DivipolaRecord[],
): CountryTables {
  const regionRows = rows.filter((row) => REGION_TYPES.includes(row.location_type));
  const departments = new Map<string, LocationRow>();
  for (const record of divipola) {
    if (departments.has(record.cod_dpto)) continue;
    const wanted = normalizePlaceName(DEPARTMENT_ALIASES[record.cod_dpto] ?? record.dpto);
    const region = regionRows.find((row) => normalizePlaceName(placeName(row)) === wanted);
    if (!region) throw new Error(`department ${record.cod_dpto} ${record.dpto} has no region`);
    departments.set(record.cod_dpto, region);
  }

  const citiesByRegion = Map.groupBy(cities, (row) => regionOf(row)?.location_code ?? "");
  const candidatesFor = (record: DivipolaRecord) =>
    citiesByRegion.get(departments.get(record.cod_dpto)?.location_code ?? "") ?? [];

  const matches = new Map<string, Match>();
  const claimed = new Set<string>();
  const claim = (
    record: DivipolaRecord,
    found: LocationRow[],
    name: (row: LocationRow) => string,
  ) => {
    const row = found.sort(preferred)[0];
    if (!row) return;
    matches.set(record.cod_mpio, { row, name: name(row) });
    for (const duplicate of found) claimed.add(duplicate.location_code);
  };

  for (const record of divipola) {
    const alias = MUNICIPALITY_ALIASES[record.cod_mpio];
    const wanted = normalizePlaceName(alias ?? record.nom_mpio);
    const exact = candidatesFor(record).filter(
      (row) => normalizePlaceName(placeName(row)) === wanted,
    );
    claim(record, exact, () => alias ?? officialName(record.nom_mpio));
  }

  // DataForSEO often lists the common form of an official name ("Cali" for "Santiago de
  // Cali", "Santa Cruz de Lorica" for "Lorica"); accept it only when it is unambiguous.
  const fuzzy = new Map<string, LocationRow[]>();
  for (const record of divipola) {
    if (matches.has(record.cod_mpio)) continue;
    const official = tokens(record.nom_mpio);
    const found = candidatesFor(record).filter((row) => {
      if (claimed.has(row.location_code)) return false;
      const listed = tokens(placeName(row));
      return indexOf(official, listed) !== -1 || indexOf(listed, official) !== -1;
    });
    if (new Set(found.map((row) => normalizePlaceName(placeName(row)))).size === 1) {
      fuzzy.set(record.cod_mpio, found);
    }
  }
  const fuzzyClaims = Map.groupBy([...fuzzy.values()].flat(), (row) => row.location_code);
  for (const record of divipola) {
    const found = fuzzy.get(record.cod_mpio);
    if (!found || found.some((row) => (fuzzyClaims.get(row.location_code)?.length ?? 0) > 1)) {
      continue;
    }
    claim(record, found, (row) => commonName(officialName(record.nom_mpio), placeName(row)));
  }

  const regions = [...new Map([...departments].map(([code, row]) => [row.location_code, code]))]
    .map(([locationCode, departmentCode]): RegionRow => {
      const record = divipola.find((r) => r.cod_dpto === departmentCode);
      return [Number(locationCode), officialName(record?.dpto ?? "")];
    })
    .sort((a, b) => a[0] - b[0]);
  const regionIndex = new Map(regions.map(([code], index) => [String(code), index]));

  const seen = new Set<string>();
  const cityRows = divipola.map((record): CityRow => {
    const match = matches.get(record.cod_mpio);
    if (match && seen.has(match.row.location_code)) {
      throw new Error(`${match.row.location_name} matched two municipalities`);
    }
    if (match) seen.add(match.row.location_code);
    const region = departments.get(record.cod_dpto)?.location_code ?? "";
    return [
      match ? Number(match.row.location_code) : null,
      match?.name ?? officialName(record.nom_mpio),
      regionIndex.get(region) ?? null,
      [coordinate(record.latitud), coordinate(record.longitud)],
      record.cod_mpio,
    ];
  });

  return {
    country,
    regions,
    cities: cityRows.sort((a, b) => compareKeys(String(a[0] ?? a[4]), String(b[0] ?? b[4]))),
  };
}

/** The listed name with the official accents when it is part of the official name. */
function commonName(official: string, listed: string): string {
  const words = official.split(" ");
  const comparable = words.flatMap((word, index) =>
    tokens(word).map((token) => ({ token, index })),
  );
  const listedTokens = tokens(listed);
  const start = indexOf(
    comparable.map(({ token }) => token),
    listedTokens,
  );
  const first = comparable[start];
  const last = comparable[start + listedTokens.length - 1];
  if (start === -1 || !first || !last) return listed;
  return words.slice(first.index, last.index + 1).join(" ");
}

function coordinate(value: string): number {
  const parsed = Number(value.replace(",", "."));
  if (!Number.isFinite(parsed)) throw new Error(`invalid DIVIPOLA coordinate ${value}`);
  return parsed;
}

const ATTEMPTS = 4;

type StreamedResponse = Response & { body: ReadableStream<Uint8Array> };

// datos.gov.co answers 500/503 now and then under load; a later attempt succeeds.
async function get(url: string): Promise<StreamedResponse> {
  for (let attempt = 1; ; attempt++) {
    const response = await fetch(url);
    if (response.ok && response.body) return response as StreamedResponse;
    if (response.status < 500 || attempt === ATTEMPTS) {
      throw new Error(`GET ${url} answered ${response.status}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
  }
}

async function readLocations(): Promise<LocationRow[]> {
  const response = await get(LOCATIONS_CSV);
  const rows: LocationRow[] = [];
  for await (const row of Readable.fromWeb(response.body).pipe(parse(CSV_OPTIONS))) {
    rows.push(row as LocationRow);
  }
  return rows;
}

async function readDivipola(): Promise<DivipolaRecord[]> {
  const response = await get(DIVIPOLA_JSON);
  const records = (await response.json()) as DivipolaRecord[];
  if (records.length !== DIVIPOLA_RECORDS) {
    throw new Error(`DIVIPOLA returned ${records.length} records, expected ${DIVIPOLA_RECORDS}`);
  }
  return records;
}

function writeJson(name: string, value: unknown): void {
  writeFileSync(new URL(name, OUTPUT), `${JSON.stringify(value)}\n`);
}

/** Each display name once, with every alias of the cities shown under it. */
export function cityNames(cities: readonly CityRow[]): CityName[] {
  const aliases = new Map<string, Map<string, string>>();
  for (const row of cities) {
    const own = aliases.get(row[1]) ?? new Map<string, string>();
    for (const alias of row.length === 4 ? row[3] : []) {
      const key = normalizePlaceName(alias);
      if (!own.has(key)) own.set(key, alias);
    }
    aliases.set(row[1], own);
  }
  return [...aliases]
    .sort(([a], [b]) => compareKeys(a, b))
    .map(([name, own]) => (own.size ? [name, ...own.values()] : name));
}

async function main(): Promise<void> {
  const countries = measurableCountries().map(({ code }) => code);
  const [locations, divipola, geonames] = await Promise.all([
    readLocations(),
    readDivipola(),
    readGeoNames(new Set(countries)),
  ]);
  const divipolaCountry = locations.find(
    (row) => row.location_type === "Country" && row.location_name === DIVIPOLA_COUNTRY_NAME,
  )?.country_iso_code;
  const byCountry = Map.groupBy(locations, (row) => row.country_iso_code);

  rmSync(OUTPUT, { recursive: true, force: true });
  mkdirSync(OUTPUT, { recursive: true });
  const files: Record<string, string> = {};
  for (const code of countries) {
    const rows = byCountry.get(code) ?? [];
    const { spanish, ...tables } = rows.length
      ? buildCountry(
          rows,
          code === divipolaCountry ? { divipola } : { geonames: geonames.forCountry(code) },
        )
      : { country: code, regions: [], cities: [] };
    const geoDataHash = contentHash(expandGeoFile(tables));
    const prefix = code.toLowerCase();
    const file = `${prefix}-${GEO_DATA_VERSION}.json`;
    writeJson(file, { version: GEO_DATA_VERSION, geoDataHash, ...tables } satisfies GeoFile);
    writeJson(`${prefix}-names.json`, {
      version: GEO_DATA_VERSION,
      country: code,
      names: cityNames(tables.cities),
    } satisfies GeoNamesFile);
    files[file] = geoDataHash;
    if (code === divipolaCountry) reportDivipola(tables, rows, divipola);
    const named = spanish ? ` (${spanish.cities} and ${spanish.regions} in Spanish)` : "";
    console.log(
      `${code}: ${tables.cities.length} cities, ${tables.regions.length} regions${named}`,
    );
  }
  writeJson("manifest.json", {
    version: GEO_DATA_VERSION,
    sourceCsv: LOCATIONS_CSV,
    sourceDivipola: DIVIPOLA_JSON,
    sourceGeoNames: geonames.sources,
    geoDataHash: files,
  });
}

function reportDivipola(
  tables: CountryTables,
  rows: readonly LocationRow[],
  divipola: readonly DivipolaRecord[],
): void {
  const places = expandGeoFile(tables).filter((place) => place.divipola);
  const official = new Map(divipola.map((r) => [r.cod_mpio, officialName(r.nom_mpio)]));
  console.log("Municipalities matched under another name:");
  for (const place of places) {
    const name = official.get(place.divipola?.municipalityCode ?? "");
    if (name !== place.name)
      console.log(`  ${place.divipola?.municipalityCode} ${name} → ${place.name}`);
  }
  const cities = places.filter((p) => p.level === "city");
  console.log(
    `DIVIPOLA municipalities: ${cities.length} city, ${places.length - cities.length} region`,
  );
  // Same-name duplicates of a matched city are expected and left out of the list.
  const matched = new Set(cities.map((p) => p.normalized));
  const dropped = rows.filter(
    (row) => CITY_TYPES.has(row.location_type) && !matched.has(normalizePlaceName(placeName(row))),
  );
  console.log(`Listed cities matched to no municipality (${dropped.length}):`);
  for (const row of dropped) console.log(`  ${row.location_code} ${row.location_name}`);
}

if (import.meta.main) await main();
