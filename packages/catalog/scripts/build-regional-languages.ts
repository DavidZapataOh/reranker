/**
 * Builds data/regional-languages.json: the places whose own main language differs from their
 * country's, where the country's first language would measure them in the wrong one.
 *
 * - Switzerland: each municipality's language area (BFS `SPRGEB2020`, the majority main language
 *   of its residents in the Structural Survey), joined to Google's cities by canton and name.
 * - Belgium: the language areas of the Constitution (art. 4) and the language laws: Brussels-Capital
 *   and Wallonia speak French, the nine municipalities of the German-speaking Community German.
 *   Flanders and Dutch-speaking Brussels stay Dutch, which is not measured.
 * - Canada: Quebec, where French is the official language (Charter of the French Language, s. 1).
 *
 * Usage: pnpm --filter @reranker/catalog regional-languages:build
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { mainLanguage } from "@reranker/i18n/countries";
import type { MeasurementLanguage } from "@reranker/schema/measurement";
import { unzipSync } from "fflate";
import {
  type Coordinate,
  expandGeoFile,
  GEO_DATA_VERSION,
  type GeoFile,
  type GeoPlace,
} from "../src/geo/format.ts";
import { normalizePlaceName } from "../src/geo/normalize.ts";

// DataForSEO's location codes are Google Ads criteria IDs; this file gives each one its parent.
const GEOTARGETS =
  "https://developers.google.com/static/google-ads/api/data/geo/geotargets-2026-10-06.csv.zip";
const BFS_LEVELS = "https://www.agvchapp.bfs.admin.ch/api/communes/levels?date=01-11-2026";
const BFS_LEVELS_2000 = "https://www.agvchapp.bfs.admin.ch/api/communes/levels?date=01-01-2000";

// BFS language areas: 1 German, 2 French, 3 Italian, 4 Romansh. Romansh is not measured, and its
// speakers are measured in German, the canton's majority language.
const BFS_AREA: Record<string, MeasurementLanguage> = {
  "1": "de",
  "2": "fr",
  "3": "it",
  "4": "de",
};
// Where no municipality matches, the canton's majority main language (BFS Structural Survey).
// Only cantons with municipalities in more than one language area need it.
const BILINGUAL_CANTONS: Record<string, MeasurementLanguage> = {
  "Canton of Bern": "de",
  Fribourg: "fr",
  Valais: "fr",
  Grisons: "de",
  Jura: "fr",
};
// Brussels-Capital (province) and Wallonia (region) are French-speaking language areas.
const BE_FRENCH = new Set(["20052", "9069524"]);
// The German language area: Royal Decree of 1963 and art. 4 of the Belgian Constitution.
const BE_GERMAN = new Set(
  [
    "Eupen",
    "Kelmis",
    "La Calamine",
    "Lontzen",
    "Raeren",
    "Amel",
    "Amblève",
    "Büllingen",
    "Bullange",
    "Burg-Reuland",
    "Bütgenbach",
    "Butgenbach",
    "Sankt Vith",
    "Saint-Vith",
    "Sankt-Vith",
  ].map(normalizePlaceName),
);
const CA_QUEBEC = "20123";

type Target = { id: string; name: string; parent: string; type: string };

async function download(url: string): Promise<{ bytes: Uint8Array; sha256: string }> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  return { bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
}

function csvRows(text: string): string[][] {
  return text
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const cells: string[] = [];
      for (const match of line.matchAll(/("([^"]*)"|[^,]*)(,|$)/g)) {
        cells.push(match[2] ?? match[1] ?? "");
        if (match[3] === "") break;
      }
      return cells;
    });
}

const geotargetsZip = await download(GEOTARGETS);
const [csvName, csv] =
  Object.entries(unzipSync(geotargetsZip.bytes)).find(([name]) => name.endsWith(".csv")) ?? [];
if (!csv || !csvName) throw new Error("no CSV in the geotargets archive");
const targets = new Map<string, Target>();
for (const [id, name, , parent, , type] of csvRows(new TextDecoder().decode(csv)).slice(1)) {
  if (id && name) targets.set(id, { id, name, parent: parent ?? "", type: type ?? "" });
}
const ancestor = (id: string, type: string): Target | null => {
  for (let t = targets.get(id); t; t = targets.get(t.parent)) if (t.type === type) return t;
  return null;
};
const within = (id: string, ancestors: ReadonlySet<string>): boolean => {
  for (let t = targets.get(id); t; t = targets.get(t.parent)) if (ancestors.has(t.id)) return true;
  return false;
};

// "St-Imier" is "Saint-Imier", "Wil (ZH)" is "Wil", "Biel/Bienne" is either.
const nameKey = (name: string) =>
  normalizePlaceName(name).replace(/\b(saint|sankt|st)\b\.?/g, "st");
const communeNames = (name: string) =>
  [name, name.replace(/\s*\(.*\)$/, ""), ...name.split("/")].map(nameKey);

/** Each canton|name's language area; null where two municipalities so named differ. */
async function languageAreas(url: string, area: string) {
  const { bytes, sha256 } = await download(url);
  const [header = [], ...communes] = csvRows(new TextDecoder().decode(bytes));
  const column = (name: string) => {
    const index = header.indexOf(name);
    if (index === -1) throw new Error(`${url} has no ${name}`);
    return index;
  };
  const [NAME, CANTON, AREA] = [column("Name"), column("CantonId"), column(area)];
  const byName = new Map<string, MeasurementLanguage | null>();
  const cantons = new Map<string, Set<MeasurementLanguage>>();
  for (const row of communes) {
    const language = BFS_AREA[row[AREA] ?? ""];
    const canton = row[CANTON] ?? "";
    if (!language) throw new Error(`unknown language area for ${row[NAME]}`);
    cantons.set(canton, (cantons.get(canton) ?? new Set()).add(language));
    for (const name of communeNames(row[NAME] ?? "")) {
      const key = `${canton}|${name}`;
      byName.set(key, byName.has(key) && byName.get(key) !== language ? null : language);
    }
  }
  return { url, sha256, column: area, byName, cantons };
}

const current = await languageAreas(BFS_LEVELS, "SPRGEB2020");
// Google still lists many municipalities merged since ("Malleray", "Bas-Vully"): the 2000
// snapshot finds them, with the language areas of that year's census.
const former = await languageAreas(BFS_LEVELS_2000, "SPRGEB2000");
// Google's cantons (criteria ID) under the BFS canton number.
const BFS_CANTON: Record<string, string> = {
  "20151": "1",
  "20129": "2",
  "20137": "3",
  "20147": "4",
  "20144": "5",
  "20140": "6",
  "20139": "7",
  "20134": "8",
  "20150": "9",
  "20132": "10",
  "20143": "11",
  "20131": "12",
  "20130": "13",
  "20142": "14",
  "20128": "15",
  "20127": "16",
  "20141": "17",
  "20135": "18",
  "20126": "19",
  "20145": "20",
  "20146": "21",
  "20148": "22",
  "20149": "23",
  "20138": "24",
  "20133": "25",
  "20136": "26",
};

const readGeo = (country: string): GeoFile =>
  JSON.parse(
    readFileSync(
      new URL(`../data/geo/${country.toLowerCase()}-${GEO_DATA_VERSION}.json`, import.meta.url),
      "utf8",
    ),
  ) as GeoFile;

type SwissMatch = { canton: Target; language: MeasurementLanguage | null };

function swissMatch(code: number, names: readonly string[]): SwissMatch {
  const canton = ancestor(String(code), "Canton");
  if (!canton) throw new Error(`${code} has no canton`);
  const bfs = BFS_CANTON[canton.id];
  if (!bfs) throw new Error(`${canton.name} is not a BFS canton`);
  for (const { byName } of [current, former]) {
    for (const name of names) {
      const language = byName.get(`${bfs}|${nameKey(name)}`);
      if (language) return { canton, language };
    }
  }
  const areas = [...(current.cantons.get(bfs) ?? [])];
  return { canton, language: areas.length === 1 ? (areas[0] as MeasurementLanguage) : null };
}

const distance = ([lat1, lng1]: Coordinate, [lat2, lng2]: Coordinate) =>
  Math.hypot(lat1 - lat2, (lng1 - lng2) * Math.cos((lat1 * Math.PI) / 180));

const fallbacks: string[] = [];
/**
 * Places Google lists under a former municipality or a city district ("Malleray", "Bümpliz")
 * match no current municipality, so they take the language of the nearest place of their canton
 * that does, and the canton's majority language only when they have no centroid.
 */
function swissLanguages(places: readonly GeoPlace[]): Map<number, MeasurementLanguage> {
  const matches = new Map<GeoPlace, SwissMatch>();
  for (const place of places) {
    if (place.level !== "city") continue;
    const google = targets.get(String(place.locationCode))?.name;
    const names = [place.name, ...Object.values(place.names ?? {}), ...(place.aliases ?? [])];
    matches.set(place, swissMatch(place.locationCode, google ? [google, ...names] : names));
  }
  const out = new Map<number, MeasurementLanguage>();
  for (const [place, { canton, language }] of matches) {
    if (language) {
      out.set(place.locationCode, language);
      continue;
    }
    let nearest: { language: MeasurementLanguage; km: number; name: string } | null = null;
    for (const [other, match] of matches) {
      if (!match.language || match.canton.id !== canton.id || !place.center || !other.center) {
        continue;
      }
      const km = distance(place.center, other.center);
      if (!nearest || km < nearest.km) nearest = { language: match.language, km, name: other.name };
    }
    const fallback = nearest?.language ?? BILINGUAL_CANTONS[canton.name];
    if (!fallback) throw new Error(`no language for ${place.name} (${canton.name})`);
    fallbacks.push(`${place.name} ${fallback} (${nearest ? `near ${nearest.name}` : canton.name})`);
    out.set(place.locationCode, fallback);
  }
  return out;
}

function languageOf(country: string, place: GeoPlace): MeasurementLanguage | null {
  const code = String(place.locationCode);
  if (country === "BE") {
    const names = [place.name, ...Object.values(place.names ?? {}), ...(place.aliases ?? [])];
    const google = targets.get(code)?.name;
    if (
      place.level === "city" &&
      [google ?? "", ...names].some((n) => BE_GERMAN.has(normalizePlaceName(n)))
    ) {
      return "de";
    }
    return BE_FRENCH.has(code) || within(code, BE_FRENCH) ? "fr" : null;
  }
  if (country === "CA")
    return code === CA_QUEBEC || within(code, new Set([CA_QUEBEC])) ? "fr" : null;
  return null;
}

const places: Record<string, Record<string, MeasurementLanguage>> = {};
for (const country of ["BE", "CA", "CH"] as const) {
  const main = mainLanguage(country);
  const all = expandGeoFile(readGeo(country));
  const swiss = country === "CH" ? swissLanguages(all) : new Map<number, MeasurementLanguage>();
  const language = (place: GeoPlace) =>
    swiss.get(place.locationCode) ?? languageOf(country, place) ?? main;
  const regions = new Map(
    all.filter((p) => p.level === "region").map((p) => [p.key, language(p)] as const),
  );
  const out: Record<string, MeasurementLanguage> = {};
  for (const place of all) {
    const own = language(place);
    // A city that speaks its region's language is found through the region at runtime.
    const inherited = place.regionKey === null ? main : (regions.get(place.regionKey) ?? main);
    if (own !== (place.level === "region" ? main : inherited))
      out[place.locationCode] = own as MeasurementLanguage;
  }
  places[country] = Object.fromEntries(
    Object.entries(out).sort(([a], [b]) => Number(a) - Number(b)),
  );
}

writeFileSync(
  new URL("../data/regional-languages.json", import.meta.url),
  `${JSON.stringify(
    {
      sources: [
        { url: GEOTARGETS, sha256: geotargetsZip.sha256 },
        ...[current, former].map(({ url, sha256, column }) => ({ url, sha256, column })),
      ],
      places,
    },
    null,
    2,
  )}\n`,
);
console.log(
  Object.entries(places)
    .map(([country, list]) => `${country}: ${Object.keys(list).length}`)
    .join(", "),
);
if (fallbacks.length) console.log(`By proximity, ${fallbacks.length}: ${fallbacks.join("; ")}`);
