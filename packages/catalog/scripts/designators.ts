// Names DataForSEO lists with an English designator ("Municipality of Madrid", "Capital
// Department") read with each language's own word for it.
import type { MeasurementLanguage } from "@reranker/schema/measurement";
import { normalizePlaceName } from "../src/geo/normalize.ts";

type Designator =
  | "department"
  | "municipality"
  | "province"
  | "district"
  | "partido"
  | "state"
  | "region"
  | "county"
  | "community"
  | "governorate"
  | "prefecture"
  | "districtMunicipality"
  | "regionalCountyMunicipality";

/**
 * Each language's word, as its national statistics offices and encyclopedias write it. Quebec's
 * "municipalité régionale de comté" and Lithuania's district municipalities ("rajono
 * savivaldybė") are units of their own, not a municipality inside a county or district.
 */
const WORDS: Record<MeasurementLanguage, Record<Designator, string>> = {
  en: {
    department: "Department",
    municipality: "Municipality",
    province: "Province",
    district: "District",
    partido: "Partido",
    state: "State",
    region: "Region",
    county: "County",
    community: "Community",
    governorate: "Governorate",
    prefecture: "Prefecture",
    districtMunicipality: "District Municipality",
    regionalCountyMunicipality: "Regional County Municipality",
  },
  es: {
    department: "Departamento",
    municipality: "Municipio",
    province: "Provincia",
    district: "Distrito",
    partido: "Partido",
    state: "Estado",
    region: "Región",
    county: "Condado",
    community: "Comunidad",
    governorate: "Gobernación",
    prefecture: "Prefectura",
    districtMunicipality: "Municipio del distrito",
    regionalCountyMunicipality: "Municipio regional de condado",
  },
  pt: {
    department: "Departamento",
    municipality: "Município",
    province: "Província",
    district: "Distrito",
    partido: "Partido",
    state: "Estado",
    region: "Região",
    county: "Condado",
    community: "Comunidade",
    governorate: "Governadoria",
    prefecture: "Prefeitura",
    districtMunicipality: "Município do distrito",
    regionalCountyMunicipality: "Município regional de condado",
  },
  fr: {
    department: "Département",
    municipality: "Municipalité",
    province: "Province",
    district: "District",
    partido: "Partido",
    state: "État",
    region: "Région",
    county: "Comté",
    community: "Communauté",
    governorate: "Gouvernorat",
    prefecture: "Préfecture",
    districtMunicipality: "Municipalité du district",
    regionalCountyMunicipality: "Municipalité régionale de comté",
  },
  // Spain's and Latin America's municipalities are "comuni" in Italian.
  it: {
    department: "Dipartimento",
    municipality: "Comune",
    province: "Provincia",
    district: "Distretto",
    partido: "Partido",
    state: "Stato",
    region: "Regione",
    county: "Contea",
    community: "Comunità",
    governorate: "Governatorato",
    prefecture: "Prefettura",
    districtMunicipality: "Comune distrettuale",
    regionalCountyMunicipality: "Municipalità regionale di contea",
  },
  // German keeps the Spanish word for the units it has none for ("Departamento Capital",
  // "Partido La Matanza", "Municipio Lerma"), as the German Wikipedia does.
  de: {
    department: "Departamento",
    municipality: "Municipio",
    province: "Provinz",
    district: "Distrikt",
    partido: "Partido",
    state: "Bundesstaat",
    region: "Region",
    county: "County",
    community: "Gemeinschaft",
    governorate: "Gouvernement",
    prefecture: "Präfektur",
    districtMunicipality: "Bezirksgemeinde",
    regionalCountyMunicipality: "Regionale Grafschaftsgemeinde",
  },
};

const DESIGNATORS = Object.keys(WORDS.en) as Designator[];
const byWord = (language: MeasurementLanguage) =>
  new Map(DESIGNATORS.map((designator) => [WORDS[language][designator], designator]));
const ENGLISH = byWord("en");
const SPANISH = byWord("es");
// Longest first, so "Regional County Municipality" is one designator rather than "Municipality".
const words = (map: ReadonlyMap<string, Designator>) =>
  [...map.keys()].sort((a, b) => b.length - a.length).join("|");
const ENGLISH_PREFIX = new RegExp(`^(${words(ENGLISH)}) of (.+)$`);
const ENGLISH_SUFFIX = new RegExp(`^(.+?) (${words(ENGLISH)})$`);
// DataForSEO writes a few with the word first and no "of" ("Department Capital", "Municipality B").
const ENGLISH_BARE = /^(Department|Municipality) (.+)$/;
// "del" and "de los" would need the article back in other languages; those names are left alone.
const SPANISH_PREFIX = new RegExp(`^(${words(SPANISH)})( de)? (?!del |de los |de las )(.+)$`);

export type Designated = { designator: Designator; core: string; language: "en" | "es" };

export function parseDesignated(name: string): Designated | null {
  const prefix = ENGLISH_PREFIX.exec(name) ?? ENGLISH_BARE.exec(name);
  if (prefix?.[1] && prefix[2]) return english(prefix[1], prefix[2]);
  const suffix = ENGLISH_SUFFIX.exec(name);
  if (suffix?.[1] && suffix[2]) return english(suffix[2], suffix[1]);
  const spanish = SPANISH_PREFIX.exec(name);
  const designator = spanish?.[1] && SPANISH.get(spanish[1]);
  if (designator && spanish[3]) return { designator, core: spanish[3], language: "es" };
  return null;
}

function english(word: string, core: string): Designated | null {
  const designator = ENGLISH.get(word);
  return designator ? { designator, core, language: "en" } : null;
}

/**
 * Where a country's own statistics office writes the Spanish word without "de": INDEC's
 * "Departamento Capital", INE Venezuela's "Municipio Maneiro", ONE's "Provincia Hermanas
 * Mirabal" and INEC Costa Rica's "Distrito Mata Redonda". Elsewhere it takes "de", as INEGI's
 * "Municipio de Lerma", INE Paraguay's "Departamento de Alto Paraná" or INE Spain's
 * "Provincia de Córdoba".
 */
const SPANISH_WITHOUT_DE: Partial<Record<string, readonly Designator[]>> = {
  AR: ["department"],
  CR: ["district"],
  DO: ["province"],
  VE: ["municipality"],
};

// Montevideo's municipalities are letters ("Municipio B"); no language puts a preposition there.
const LETTER = /^\p{Lu}$/u;
const VOWEL = /^[aeiouàâäéèêëíîïóôöúûü]/iu;

export function renderDesignated(
  { designator, core }: Pick<Designated, "designator" | "core">,
  language: MeasurementLanguage,
  country: string,
): string {
  const word = WORDS[language][designator];
  if (LETTER.test(core)) return `${word} ${core}`;
  if (language === "en") {
    return designator === "community" ? `${word} of ${core}` : `${core} ${word}`;
  }
  // Where the name stands in apposition ("Departamento Capital") every language keeps it so.
  if (SPANISH_WITHOUT_DE[country]?.includes(designator)) return `${word} ${core}`;
  switch (language) {
    case "es":
      return `${word} de ${core}`;
    case "pt":
      return `${word} de ${core}`;
    case "fr":
      return VOWEL.test(core) ? `${word} d'${core}` : `${word} de ${core}`;
    case "it":
      return `${word} di ${core}`;
    case "de":
      return `${word} ${core}`;
  }
}

const diacritics = (name: string) => name.normalize("NFD").replace(/\P{M}/gu, "").length;

/** `core` with the accents the unit's own names in any language write it with ("Alto Paraná"). */
export function accentedFrom(core: string, names: Iterable<string>): string {
  const key = normalizePlaceName(core);
  let best = core;
  for (const name of names) {
    const own = parseDesignated(name)?.core ?? name;
    if (normalizePlaceName(own) === key && diacritics(own) > diacritics(best)) best = own;
  }
  return best;
}

export type Speller = (core: string, language: MeasurementLanguage) => string;
export type PlaceSpelling = {
  name: string;
  aliases: readonly string[];
  names: Record<string, string>;
};

/**
 * The name a designated unit is called after, as its own place reads in each language:
 * "Municipality of Seville" is "Comune di Siviglia" because the city of Seville is "Siviglia"
 * in Italian, and DataForSEO's "Cordoba" regains its accent. A place's own name outranks
 * another's alias.
 */
export function speller(places: Iterable<PlaceSpelling>): Speller {
  const byName = new Map<string, PlaceSpelling>();
  // A designated unit never names another one, nor itself through its own alias.
  const all = [...places].filter((place) => parseDesignated(place.name) === null);
  for (const place of all)
    for (const alias of place.aliases) byName.set(normalizePlaceName(alias), place);
  for (const place of all) byName.set(normalizePlaceName(place.name), place);
  return (core, language) => {
    const place = byName.get(normalizePlaceName(core));
    if (!place) return core;
    return language === "es" ? place.name : (place.names[language] ?? place.name);
  };
}

/**
 * The name in `language` when the given one carries another language's designator, English or
 * Spanish, written with the language's own word, order and preposition: "Capital Department",
 * "Comune di Lerma", "Partido Morón" in German. Other names come back unchanged.
 */
export function localDesignated(
  name: string,
  language: MeasurementLanguage,
  country: string,
  spell: Speller,
): string {
  const parsed = parseDesignated(name);
  if (!parsed || parsed.language === language) return name;
  // Already in the language's own form: "Provincia di Siviglia" is Italian, not Spanish, while
  // "Partido de Escobar" in German still needs its "de" dropped.
  if (language !== "en") {
    const own = renderDesignated({ ...parsed, core: "\0" }, language, country).split("\0")[0];
    if (own && name.startsWith(own) && !/^(de|del|di) /.test(name.slice(own.length))) {
      return name;
    }
  }
  return renderDesignated({ ...parsed, core: spell(parsed.core, language) }, language, country);
}
