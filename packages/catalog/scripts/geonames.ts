// Spanish names for DataForSEO's places, from the GeoNames gazetteer (CC BY 4.0, see NOTICE).
import { createHash } from "node:crypto";
import { Unzip, UnzipInflate } from "fflate";
import { normalizePlaceName } from "../src/geo/normalize.ts";

const DUMP = "https://download.geonames.org/export/dump/";
const ADMIN1 = `${DUMP}admin1CodesASCII.txt`;
const ADMIN2 = `${DUMP}admin2Codes.txt`;
const COUNTRIES = `${DUMP}countryInfo.txt`;
const CITIES = { url: `${DUMP}cities500.zip`, file: "cities500.txt" };
const ALTERNATE_NAMES = { url: `${DUMP}alternateNamesV2.zip`, file: "alternateNamesV2.txt" };

export type AlternateName = {
  id: number;
  name: string;
  lang: "es" | "en" | "";
  preferred: boolean;
  short: boolean;
};

export type GeoNamesEntry = {
  id: number;
  kind: "adm1" | "adm2" | "place";
  admin1: string;
  admin2: string;
  /** The local name, except first-level divisions, which GeoNames lists in English. */
  name: string;
  asciiName: string;
  population: number;
  alternates: AlternateName[];
};

export type CountryGeoNames = { spanishSpeaking: boolean; entries: readonly GeoNamesEntry[] };

export type Naming = { name: string; aliases: string[]; spanish: boolean };

export type RegionInput = { code: number; name: string; level: 1 | 2 };
export type CityInput = { code: number; name: string; region: number | null };

// English designators DataForSEO writes around a region's name, and their Spanish form.
const DESIGNATORS: Record<string, string> = {
  community: "Comunidad",
  county: "Condado",
  department: "Departamento",
  district: "Distrito",
  governorate: "Gobernación",
  municipality: "Municipio",
  partido: "Partido",
  prefecture: "Prefectura",
  province: "Provincia",
  region: "Región",
  state: "Estado",
};
const ENGLISH_PREFIX = new RegExp(`^(${Object.keys(DESIGNATORS).join("|")}) of `);
const ENGLISH_SUFFIX = new RegExp(` (${Object.keys(DESIGNATORS).join("|")})$`);
const SPANISH_PREFIX = new RegExp(
  `^(${Object.values(DESIGNATORS).map(normalizePlaceName).join("|")})( autonoma)?( de| del| de la)? `,
);
const LATIN = /^[\p{Script=Latin}\p{M}\p{N}\p{P}\p{Zs}]+$/u;

function designated(normalized: string): { designator: string | null; core: string } {
  const match = ENGLISH_PREFIX.exec(normalized) ?? ENGLISH_SUFFIX.exec(normalized);
  if (match?.[1]) return { designator: match[1], core: normalized.replace(match[0], "").trim() };
  return { designator: null, core: normalized.replace(SPANISH_PREFIX, "") };
}

/** Lookup keys, strictest first: as written, without spaces, without designator, both. */
function lookupKeys(name: string): string[] {
  const normalized = normalizePlaceName(name);
  const { core } = designated(normalized);
  return [normalized, normalized.replaceAll(" ", ""), core, core.replaceAll(" ", "")];
}

function groupByKeys(entries: readonly GeoNamesEntry[], keysOf: (e: GeoNamesEntry) => string[]) {
  const keys = (entry: GeoNamesEntry) => [...new Set(keysOf(entry))].filter(Boolean);
  const pairs = entries.flatMap((entry) => keys(entry).map((key) => ({ key, entry })));
  const groups = Map.groupBy(pairs, ({ key }) => key);
  return new Map([...groups].map(([key, found]) => [key, found.map(({ entry }) => entry)]));
}

const areaKey = (entry: GeoNamesEntry) =>
  entry.kind === "adm1" ? `adm1:${entry.admin1}` : `adm2:${entry.admin1}.${entry.admin2}`;

/**
 * Pairs DataForSEO's regions and cities with GeoNames entries and names them in Spanish.
 * Places without a confident pair are left out and keep DataForSEO's name.
 */
export function spanishNames(
  input: { regions: readonly RegionInput[]; cities: readonly CityInput[] },
  data: CountryGeoNames,
): { regions: Map<number, Naming>; cities: Map<number, Naming> } {
  const areas = data.entries.filter((entry) => entry.kind !== "place");
  const areaStages = [0, 1, 2, 3].map((stage) =>
    groupByKeys(areas, (entry) =>
      [entry.name, entry.asciiName, ...entry.alternates.map((a) => a.name)].map(
        (name) => lookupKeys(name)[stage] ?? "",
      ),
    ),
  );
  const places = data.entries.filter((entry) => entry.kind === "place");
  // A place's own name outranks its alternates, which include former and nearby names.
  const placeTiers = [
    groupByKeys(places, (entry) => [entry.name, entry.asciiName].map(normalizePlaceName)),
    groupByKeys(places, (entry) => entry.alternates.map((a) => normalizePlaceName(a.name))),
  ];

  // A city name found once in the country tells which areas its DataForSEO region covers.
  const votes = new Map<number, Map<string, number>>();
  for (const city of input.cities) {
    const found = placeTiers[0]?.get(normalizePlaceName(city.name)) ?? [];
    const [entry] = found;
    if (city.region === null || found.length !== 1 || !entry) continue;
    const tally = votes.get(city.region) ?? new Map<string, number>();
    for (const key of [`adm1:${entry.admin1}`, `adm2:${entry.admin1}.${entry.admin2}`]) {
      tally.set(key, (tally.get(key) ?? 0) + 1);
    }
    votes.set(city.region, tally);
  }
  const votesFor = (region: number, entry: GeoNamesEntry) =>
    votes.get(region)?.get(areaKey(entry)) ?? 0;

  const regions = new Map<number, GeoNamesEntry>();
  for (const region of input.regions) {
    const level = region.level === 1 ? "adm1" : "adm2";
    for (const [stage, key] of lookupKeys(region.name).entries()) {
      const found = areaStages[stage]?.get(key) ?? [];
      const atLevel = found.filter((entry) => entry.kind === level);
      const [best, second] = (atLevel.length ? atLevel : found).toSorted(
        (a, b) => votesFor(region.code, b) - votesFor(region.code, a),
      );
      if (best && (!second || votesFor(region.code, best) > votesFor(region.code, second))) {
        regions.set(region.code, best);
      }
      if (found.length) break;
    }
  }

  // Two DataForSEO regions never share an area ("Buenos Aires", the autonomous city, also
  // names the province): the one whose cities lie there keeps it, the other follows its cities.
  const claims = Map.groupBy(regions, ([, entry]) => entry.id);
  const byArea = new Map(areas.map((entry) => [areaKey(entry), entry]));
  for (const claim of claims.values()) {
    const [, ...losers] = claim.toSorted(
      ([a, entry], [b]) => votesFor(b, entry) - votesFor(a, entry),
    );
    for (const [code, entry] of losers) {
      regions.delete(code);
      const tally = [...(votes.get(code) ?? [])].filter(([key]) => key.startsWith(entry.kind));
      const total = tally.reduce((sum, [, count]) => sum + count, 0);
      const [key, count = 0] = tally.toSorted((a, b) => b[1] - a[1])[0] ?? [];
      const area = key === undefined ? undefined : byArea.get(key);
      if (area && count * 2 > total && !claims.has(area.id)) regions.set(code, area);
    }
  }

  const cities = new Map<number, GeoNamesEntry>();
  for (const city of input.cities) {
    const region = city.region === null ? undefined : regions.get(city.region);
    const within = (found: readonly GeoNamesEntry[]) => {
      if (!region) return found.length === 1 ? found : [];
      const sameAdmin1 = found.filter((entry) => entry.admin1 === region.admin1);
      const sameAdmin2 = sameAdmin1.filter((entry) => entry.admin2 === region.admin2);
      return region.kind === "adm2" && sameAdmin2.length ? sameAdmin2 : sameAdmin1;
    };
    const key = normalizePlaceName(city.name);
    const found = placeTiers.map((tier) => within(tier.get(key) ?? [])).find((f) => f.length);
    const [best] = (found ?? []).toSorted((a, b) => b.population - a.population || a.id - b.id);
    if (best) cities.set(city.code, best);
  }

  const listed = new Map([...input.regions, ...input.cities].map((p) => [p.code, p.name]));
  const name = (pairs: ReadonlyMap<number, GeoNamesEntry>, naming: typeof cityNaming) =>
    new Map([...pairs].map(([code, entry]) => [code, naming(listed.get(code) ?? "", entry, data)]));
  return { regions: name(regions, regionNaming), cities: name(cities, cityNaming) };
}

const spanish = (entry: GeoNamesEntry) => entry.alternates.filter((a) => a.lang === "es");
const local = (entry: GeoNamesEntry) => [
  ...(entry.kind === "adm1" ? [] : [entry.name]),
  ...entry.alternates.filter((a) => a.lang === "" && LATIN.test(a.name)).map((a) => a.name),
];
const formal = (names: readonly AlternateName[]) =>
  names.find((a) => a.preferred && !a.short) ?? names.find((a) => !a.short);
const sameAs = (names: readonly string[], name: string) =>
  names.find((candidate) => normalizePlaceName(candidate) === normalizePlaceName(name));

function cityNaming(listed: string, entry: GeoNamesEntry, data: CountryGeoNames): Naming {
  const es = spanish(entry);
  const esNames = es.map((a) => a.name);
  // English names a capital after its country ("Mexico City" is "Ciudad de México").
  const capitalOf = /^(.+) city$/.exec(normalizePlaceName(listed))?.[1];
  // DataForSEO lists Google's own name without accents. Where Spanish is the local language
  // that name already is the Spanish one; elsewhere a Spanish exonym ("Londres") wins.
  const spanishName =
    sameAs(esNames, listed) ??
    (capitalOf ? sameAs([...esNames, ...local(entry)], `ciudad de ${capitalOf}`) : undefined) ??
    (data.spanishSpeaking ? sameAs(local(entry), listed) : undefined) ??
    formal(es)?.name ??
    esNames[0];
  return naming(spanishName, entry.name, [listed, entry.name, ...esNames], data);
}

function regionNaming(listed: string, entry: GeoNamesEntry, data: CountryGeoNames): Naming {
  const es = spanish(entry);
  const esNames = es.map((a) => a.name);
  // Where Spanish is the local language, language-less names are Spanish too, except the
  // English copies of DataForSEO's own name ("Community of Madrid").
  const localNames = data.spanishSpeaking ? local(entry).filter((n) => n !== listed) : [];
  const { designator, core } = designated(normalizePlaceName(listed));
  const spanishDesignator = designator ? DESIGNATORS[designator] : undefined;
  // Abbreviations ("Buenos Aires C.F.") are never display names.
  const short = es.find((a) => a.short && !a.name.includes("."))?.name;
  const designatedForm = spanishDesignator && `${spanishDesignator} de ${short ?? core}`;
  // DataForSEO's form decides: "Andalusia" reads "Andalucía", "Community of Madrid" reads
  // "Comunidad de Madrid", and a short name gets its designator back.
  const spanishName =
    sameAs(esNames, listed) ??
    sameAs(localNames, listed) ??
    (designatedForm ? sameAs([...esNames, ...localNames], designatedForm) : short) ??
    formal(es)?.name ??
    (short && designatedForm) ??
    (data.spanishSpeaking && entry.kind === "adm2" ? entry.name : undefined);
  const own = data.spanishSpeaking ? local(entry) : entry.kind === "adm2" ? [entry.name] : [];
  const aliases = [
    listed,
    ...own,
    ...esNames,
    ...(designatedForm && short ? [designatedForm] : []),
  ];
  return naming(spanishName, listed, aliases, data);
}

/** The display name and the other names a place is written with, once each. */
function naming(
  spanishName: string | undefined,
  fallback: string,
  names: readonly string[],
  data: CountryGeoNames,
): Naming {
  const name = spanishName ?? fallback;
  const seen = new Set([normalizePlaceName(name)]);
  const aliases = names.filter((alias) => {
    const key = normalizePlaceName(alias);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { name, aliases, spanish: spanishName !== undefined || data.spanishSpeaking };
}

/** Builds the per-country data from the dump files' lines, alternate names last. */
export function geoNamesCollector(countries: ReadonlySet<string>) {
  const byCountry = new Map<string, GeoNamesEntry[]>();
  const entries = new Map<number, GeoNamesEntry>();
  const spanishSpeaking = new Set<string>();
  const add = (country: string, entry: GeoNamesEntry) => {
    if (!countries.has(country)) return;
    const list = byCountry.get(country);
    if (list) list.push(entry);
    else byCountry.set(country, [entry]);
    entries.set(entry.id, entry);
  };
  return {
    /** `admin1CodesASCII.txt` and `admin2Codes.txt`: code, name, ASCII name, geonameid. */
    area(line: string, kind: "adm1" | "adm2") {
      const [code = "", name = "", asciiName = "", id] = line.split("\t");
      const [country = "", admin1 = "", admin2 = ""] = code.split(".");
      const entry = { id: Number(id), kind, admin1, admin2, name, asciiName, population: 0 };
      add(country, { ...entry, alternates: [] });
    },
    /** A row of the main `geoname` table, as in `cities500.txt`. */
    place(line: string) {
      const f = line.split("\t");
      const [id, name = "", asciiName = ""] = f;
      const [admin1 = "", admin2 = ""] = [f[10], f[11]];
      const entry = { id: Number(id), kind: "place", admin1, admin2, name, asciiName } as const;
      add(f[8] ?? "", { ...entry, population: Number(f[14] ?? 0), alternates: [] });
    },
    // English names only pair with DataForSEO's; historic and colloquial ones never count.
    alternate(line: string) {
      const [id, entry, lang, name, preferred, short, colloquial, historic] = line.split("\t");
      if ((lang !== "es" && lang !== "en" && lang !== "") || !name) return;
      if (colloquial === "1" || historic === "1") return;
      entries.get(Number(entry))?.alternates.push({
        id: Number(id),
        name,
        lang,
        preferred: preferred === "1",
        short: short === "1",
      });
    },
    /** `countryInfo.txt`: a country whose first official language is Spanish. */
    country(line: string) {
      const f = line.split("\t");
      if (line.startsWith("#") || !f[0]) return;
      if (f[15]?.split(",")[0]?.split("-")[0] === "es") spanishSpeaking.add(f[0]);
    },
    done(): (country: string) => CountryGeoNames {
      // The dumps promise no row order; ids make every run pick the same names.
      for (const entry of entries.values()) entry.alternates.sort((a, b) => a.id - b.id);
      for (const list of byCountry.values()) list.sort((a, b) => a.id - b.id);
      return (country) => ({
        spanishSpeaking: spanishSpeaking.has(country),
        entries: byCountry.get(country) ?? [],
      });
    },
  };
}

export type GeoNamesSource = { url: string; lastModified: string; sha256: string };

/** Streams a remote file, or one file of a remote zip, line by line, hashing what it reads. */
async function readLines(
  url: string,
  onLine: (line: string) => void,
  zipped?: string,
): Promise<GeoNamesSource> {
  const response = await fetch(url);
  if (!response.ok || !response.body) throw new Error(`GET ${url} answered ${response.status}`);
  const hash = createHash("sha256");
  const decoder = new TextDecoder();
  let rest = "";
  const text = (chunk: Uint8Array, final: boolean) => {
    const lines = (rest + decoder.decode(chunk, { stream: !final })).split("\n");
    rest = lines.pop() ?? "";
    for (const line of lines) if (line) onLine(line);
    if (final && rest) onLine(rest);
  };
  let push = text;
  let found = !zipped;
  if (zipped) {
    const unzip = new Unzip((file) => {
      if (file.name !== zipped) return;
      found = true;
      file.ondata = (error, chunk, final) => {
        if (error) throw error;
        text(chunk, final);
      };
      file.start();
    });
    unzip.register(UnzipInflate);
    push = (chunk, final) => unzip.push(chunk, final);
  }
  for await (const chunk of response.body) {
    hash.update(chunk);
    push(chunk, false);
  }
  push(new Uint8Array(0), true);
  if (!found) throw new Error(`${url} has no ${zipped}`);
  const lastModified = response.headers.get("last-modified") ?? "unknown";
  return { url, lastModified, sha256: hash.digest("hex") };
}

/** Areas, populated places and their names for the given countries, and where they came from. */
export async function readGeoNames(countries: ReadonlySet<string>) {
  const collector = geoNamesCollector(countries);
  const sources = await Promise.all([
    readLines(ADMIN1, (line) => collector.area(line, "adm1")),
    readLines(ADMIN2, (line) => collector.area(line, "adm2")),
    readLines(COUNTRIES, (line) => collector.country(line)),
    readLines(CITIES.url, (line) => collector.place(line), CITIES.file),
  ]);
  sources.push(
    await readLines(ALTERNATE_NAMES.url, (line) => collector.alternate(line), ALTERNATE_NAMES.file),
  );
  return { forCountry: collector.done(), sources };
}
