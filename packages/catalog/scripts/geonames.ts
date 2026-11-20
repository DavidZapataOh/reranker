// Names in each language and centroids for DataForSEO's places, from the GeoNames gazetteer
// (CC BY 4.0, see NOTICE).
import { createHash } from "node:crypto";
import { Unzip, UnzipInflate } from "fflate";
import { type Coordinate, PLACE_LANGUAGES, type PlaceLanguage } from "../src/geo/format.ts";
import { normalizePlaceName } from "../src/geo/normalize.ts";

const DUMP = "https://download.geonames.org/export/dump/";
const ADMIN1 = `${DUMP}admin1CodesASCII.txt`;
const ADMIN2 = `${DUMP}admin2Codes.txt`;
const COUNTRIES = `${DUMP}countryInfo.txt`;
const CITIES = { url: `${DUMP}cities500.zip`, file: "cities500.txt" };
// The admin code files carry no coordinates and cities500 leaves out places under 500 people;
// the full gazetteer has both.
const ALL_COUNTRIES = { url: `${DUMP}allCountries.zip`, file: "allCountries.txt" };
const ALTERNATE_NAMES = { url: `${DUMP}alternateNamesV2.zip`, file: "alternateNamesV2.txt" };

export type AlternateName = {
  id: number;
  name: string;
  /** ISO 639-1 code; empty for a name GeoNames tags with no language, usually the local one. */
  lang: string;
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
  /** GeoNames' point: a place's centre, an area's representative point. */
  center: Coordinate | null;
  alternates: AlternateName[];
  /**
   * Every name the gazetteer row lists, in any language, normalized: they locate a city
   * listed under a name `alternates` leaves out ("Elx" for Elche), and never name one.
   */
  gazetteerNames: string[];
};

export type CountryGeoNames = {
  spanishSpeaking: boolean;
  entries: readonly GeoNamesEntry[];
  /** Populated places below `cities500`'s threshold, named like a listed city: points only. */
  minorPlaces: readonly GeoNamesEntry[];
};

export type Naming = {
  name: string;
  aliases: string[];
  spanish: boolean;
  /** The name in each language, and the languages GeoNames itself names the place in. */
  names: Record<PlaceLanguage, string>;
  own: PlaceLanguage[];
};

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
// DataForSEO's names pair only through these; names in other languages only name a place.
const PAIRING = new Set(["es", "en", ""]);
const NAMED = new Set<string>(PLACE_LANGUAGES);
const pairing = (entry: GeoNamesEntry) =>
  entry.alternates.filter((a) => PAIRING.has(a.lang)).map((a) => a.name);

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
 * Pairs DataForSEO's regions and cities with GeoNames entries, names them in Spanish and
 * locates them. Places without a confident pair are left out and keep DataForSEO's name.
 */
export function pairGeoNames(
  input: { regions: readonly RegionInput[]; cities: readonly CityInput[] },
  data: CountryGeoNames,
): {
  regions: Map<number, Naming>;
  cities: Map<number, Naming>;
  /** GeoNames' point for each located region and city, by DataForSEO code. */
  centers: Map<number, Coordinate>;
} {
  const areas = data.entries.filter((entry) => entry.kind !== "place");
  const areaStages = [0, 1, 2, 3].map((stage) =>
    groupByKeys(areas, (entry) =>
      [entry.name, entry.asciiName, ...pairing(entry)].map((name) => lookupKeys(name)[stage] ?? ""),
    ),
  );
  const places = data.entries.filter((entry) => entry.kind === "place");
  // A place's own name outranks its alternates, which include former and nearby names.
  const placeTiers = [
    groupByKeys(places, (entry) => [entry.name, entry.asciiName].map(normalizePlaceName)),
    groupByKeys(places, (entry) => pairing(entry).map(normalizePlaceName)),
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

  const centers = new Map<number, Coordinate>();
  for (const [code, entry] of regions) if (entry.center) centers.set(code, entry.center);

  // Where no place is named after a city, these locate it: any place, smaller ones included,
  // by its own name and then by a name only the gazetteer lists.
  const anyPlace = [...places, ...data.minorPlaces];
  const locatingTiers = [
    groupByKeys(anyPlace, (entry) => [entry.name, entry.asciiName].map(normalizePlaceName)),
    groupByKeys(anyPlace, (entry) => entry.gazetteerNames),
  ];
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
    const [best, second] = byPopulation(found ?? []);
    if (best) cities.set(city.code, best);
    // DataForSEO lists some towns with their designator ("Municipality of Siero").
    const keys = new Set([key, designated(key).core]);
    const located = [...keys]
      .flatMap((k) => locatingTiers.map((tier) => within(tier.get(k) ?? [])))
      .find((f) => f.length);
    const [point, rival] = best ? [best, second] : byPopulation(located ?? []);
    // Same-named places in one area share a name but not a point: only a clear pair locates one.
    if (point?.center && (!rival || point.population > rival.population)) {
      centers.set(city.code, point.center);
    }
  }

  const listed = new Map([...input.regions, ...input.cities].map((p) => [p.code, p.name]));
  const name = (pairs: ReadonlyMap<number, GeoNamesEntry>, naming: typeof cityNaming) =>
    new Map([...pairs].map(([code, entry]) => [code, naming(listed.get(code) ?? "", entry, data)]));
  return { regions: name(regions, regionNaming), cities: name(cities, cityNaming), centers };
}

const byPopulation = (found: readonly GeoNamesEntry[]) =>
  found.toSorted((a, b) => b.population - a.population || a.id - b.id);

const spanish = (entry: GeoNamesEntry) => entry.alternates.filter((a) => a.lang === "es");
const local = (entry: GeoNamesEntry) => [
  ...(entry.kind === "adm1" ? [] : [entry.name]),
  ...entry.alternates.filter((a) => a.lang === "" && LATIN.test(a.name)).map((a) => a.name),
];
/**
 * The local names that can be Spanish ones where Spanish is spoken. GeoNames repeats English
 * names untagged ("Seville" for Sevilla), so an untagged name it also tags as English is
 * English, unless it tags it as Spanish too ("Madrid").
 */
const localSpanish = (entry: GeoNamesEntry) => {
  const tagged = (lang: string) =>
    new Set(entry.alternates.filter((a) => a.lang === lang).map((a) => a.name));
  const english = tagged("en");
  const spanishNames = tagged("es");
  // A place's own name is its official local one ("A Coruña"); an area's may be English
  // ("San Jerónimo Department").
  const own = entry.kind === "place" ? entry.name : undefined;
  // Unless GeoNames prefers a Spanish name, the English one may be what people write too:
  // León's only Spanish names are "León de los Aldama" and a colloquial "León".
  const prefersSpanish = entry.alternates.some((a) => a.lang === "es" && a.preferred);
  if (!prefersSpanish && own !== undefined) return local(entry);
  return local(entry).filter(
    (name) => name === own || !english.has(name) || spanishNames.has(name),
  );
};
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
    (data.spanishSpeaking ? sameAs(localSpanish(entry), listed) : undefined) ??
    formal(es)?.name ??
    esNames[0];
  const named = naming(spanishName, entry.name, [listed, entry.name, ...esNames], data);
  return { ...named, ...localizedNames(listed, entry, data, named.name) };
}

function regionNaming(listed: string, entry: GeoNamesEntry, data: CountryGeoNames): Naming {
  const es = spanish(entry);
  const esNames = es.map((a) => a.name);
  // Where Spanish is the local language, language-less names are Spanish too, except the
  // English copies of DataForSEO's own name ("Community of Madrid").
  const localNames = data.spanishSpeaking ? localSpanish(entry).filter((n) => n !== listed) : [];
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
  const named = naming(spanishName, listed, aliases, data);
  return { ...named, ...localizedNames(listed, entry, data, named.name) };
}

/** The display name and the other names a place is written with, once each. */
function naming(
  spanishName: string | undefined,
  fallback: string,
  names: readonly string[],
  data: CountryGeoNames,
): Omit<Naming, "names" | "own"> {
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

const diacritics = (name: string) => name.normalize("NFD").replace(/\P{M}/gu, "").length;

/** The spelling in `pool` that writes `name` with the most accents: "São Paulo", not "Sao Paulo". */
function accented(name: string, pool: readonly string[]): string {
  const key = normalizePlaceName(name);
  return pool
    .filter((candidate) => normalizePlaceName(candidate) === key)
    .reduce(
      (best, candidate) => (diacritics(candidate) > diacritics(best) ? candidate : best),
      name,
    );
}

/**
 * The name people in the country write: the Spanish display name where Spanish is spoken;
 * elsewhere DataForSEO's unaccented name with the accents GeoNames writes ("Zürich" for
 * "Zurich"), else GeoNames' own name, else DataForSEO's. GeoNames names first-level divisions
 * in English, so their own name never counts.
 */
function nativeName(listed: string, entry: GeoNamesEntry, data: CountryGeoNames, display: string) {
  if (data.spanishSpeaking) return display;
  const own = entry.kind === "adm1" ? [] : [entry.name].filter((name) => LATIN.test(name));
  const pool = [...own, ...local(entry)];
  if (sameAs(pool, listed)) return accented(listed, pool);
  return own[0] ?? listed;
}

/**
 * The place's name in each language as its speakers write it: GeoNames' preferred name in that
 * language; else its name there that DataForSEO lists; else any full name GeoNames has in it
 * ("Monaco di Baviera"); else the native name, which is what speakers of any language write for
 * most towns. Accents DataForSEO drops are kept.
 */
function localizedNames(
  listed: string,
  entry: GeoNamesEntry,
  data: CountryGeoNames,
  display: string,
): Pick<Naming, "names" | "own"> {
  const native = nativeName(listed, entry, data, display);
  const names = {} as Record<PlaceLanguage, string>;
  const own: PlaceLanguage[] = [];
  for (const language of PLACE_LANGUAGES) {
    // Abbreviations ("Mexico D.F.") are never written in a question.
    const written = entry.alternates.filter(
      (a) => a.lang === language && LATIN.test(a.name) && !(a.short && a.name.includes(".")),
    );
    const preferred = written.find((a) => a.preferred);
    const chosen =
      preferred ??
      written.find((a) => sameAs([a.name], listed)) ??
      written.find((a) => !a.short) ??
      written[0];
    const pool = preferred ? [listed] : [...written.map((a) => a.name), listed];
    names[language] = chosen ? accented(chosen.name, pool) : native;
    if (chosen) own.push(language);
  }
  return { names, own };
}

// Historical, abandoned and destroyed places never locate a city that exists today.
const ABANDONED = new Set(["PPLCH", "PPLH", "PPLQ", "PPLW"]);

/**
 * Builds the per-country data from the dump files' lines, the alternate names and the full
 * gazetteer last. `cityNames` holds each country's normalized city names, the only ones a
 * place outside `cities500` is kept for.
 */
export function geoNamesCollector(
  countries: ReadonlySet<string>,
  cityNames: ReadonlyMap<string, ReadonlySet<string>> = new Map(),
) {
  const byCountry = new Map<string, GeoNamesEntry[]>();
  const minorByCountry = new Map<string, GeoNamesEntry[]>();
  const entries = new Map<number, GeoNamesEntry>();
  const spanishSpeaking = new Set<string>();
  const add = (country: string, entry: GeoNamesEntry) => {
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
      if (!countries.has(country)) return;
      const entry = { id: Number(id), kind, admin1, admin2, name, asciiName, population: 0 };
      add(country, { ...entry, center: null, alternates: [], gazetteerNames: [] });
    },
    /** A row of the main `geoname` table, as in `cities500.txt`. */
    place(line: string) {
      const f = line.split("\t");
      const country = f[8] ?? "";
      if (countries.has(country)) add(country, placeEntry(f));
    },
    /**
     * A row of `allCountries.txt`: the point of an area already read, or a populated place
     * `cities500` leaves out that goes by the name of a listed city.
     */
    gazetteer(line: string) {
      const id = Number(line.slice(0, line.indexOf("\t")));
      const known = entries.get(id);
      if (known?.kind === "place") return;
      const f = line.split("\t", 15);
      if (known) {
        known.center = coordinate(f[4], f[5]);
        return;
      }
      const listed = cityNames.get(f[8] ?? "");
      if (!listed || f[6] !== "P" || ABANDONED.has(f[7] ?? "")) return;
      const entry = placeEntry(f);
      const names = [entry.name, entry.asciiName].map(normalizePlaceName);
      if (![...names, ...entry.gazetteerNames].some((name) => listed.has(name))) return;
      const list = minorByCountry.get(f[8] ?? "") ?? [];
      list.push(entry);
      minorByCountry.set(f[8] ?? "", list);
    },
    // Historic and colloquial names never pair or name a place.
    alternate(line: string) {
      const [id, entry, lang = "", name, preferred, short, colloquial, historic] = line.split("\t");
      if (!(PAIRING.has(lang) || NAMED.has(lang)) || !name) return;
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
      for (const list of [...byCountry.values(), ...minorByCountry.values()]) {
        list.sort((a, b) => a.id - b.id);
      }
      return (country) => ({
        spanishSpeaking: spanishSpeaking.has(country),
        entries: byCountry.get(country) ?? [],
        minorPlaces: minorByCountry.get(country) ?? [],
      });
    },
  };
}

/** A populated place from the fields of a `geoname` table row. */
function placeEntry(f: readonly string[]): GeoNamesEntry {
  return {
    id: Number(f[0]),
    kind: "place",
    admin1: f[10] ?? "",
    admin2: f[11] ?? "",
    name: f[1] ?? "",
    asciiName: f[2] ?? "",
    population: Number(f[14] ?? 0),
    center: coordinate(f[4], f[5]),
    alternates: [],
    gazetteerNames: [...new Set((f[3] ?? "").split(",").filter(Boolean).map(normalizePlaceName))],
  };
}

function coordinate(lat: string | undefined, lng: string | undefined): Coordinate | null {
  if (!lat || !lng) return null;
  const point: Coordinate = [Number(lat), Number(lng)];
  return point.every(Number.isFinite) ? point : null;
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

/** Areas, populated places, their names and points for the given countries, and their sources. */
export async function readGeoNames(
  countries: ReadonlySet<string>,
  cityNames: ReadonlyMap<string, ReadonlySet<string>>,
) {
  const collector = geoNamesCollector(countries, cityNames);
  const sources = await Promise.all([
    readLines(ADMIN1, (line) => collector.area(line, "adm1")),
    readLines(ADMIN2, (line) => collector.area(line, "adm2")),
    readLines(COUNTRIES, (line) => collector.country(line)),
    readLines(CITIES.url, (line) => collector.place(line), CITIES.file),
  ]);
  // Both need the entries above: names and area points attach to them; minor places are the rest.
  sources.push(
    ...(await Promise.all([
      readLines(ALTERNATE_NAMES.url, (line) => collector.alternate(line), ALTERNATE_NAMES.file),
      readLines(ALL_COUNTRIES.url, (line) => collector.gazetteer(line), ALL_COUNTRIES.file),
    ])),
  );
  return { forCountry: collector.done(), sources };
}
