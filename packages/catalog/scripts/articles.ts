// The definite article a place's name takes in each language, for the slot grammar to fuse with
// the preposition before it ("no Rio de Janeiro", "au Havre", "al Cairo").
import type { PlaceLanguage } from "../src/geo/format.ts";
import { normalizePlaceName } from "../src/geo/normalize.ts";
import { parseDesignated } from "./designators.ts";

type PortugueseArticle = "o" | "a";

/**
 * Portuguese names that take the article without writing it, as the Senado Federal's Manual de
 * Comunicação lists them ("Artigo definido",
 * https://www12.senado.leg.br/manualdecomunicacao/estilos/artigo-definido): cities named after
 * common nouns, the islands it names, the states that require it and the Distrito Federal. Any
 * other city goes without ("em São Paulo"); the manual's optional "o Recife" is the one it adopts.
 */
const PORTUGUESE: Record<
  string,
  { cities?: Record<string, PortugueseArticle>; regions?: Record<string, PortugueseArticle> }
> = {
  BR: {
    cities: { "Rio de Janeiro": "o", Recife: "o" },
    regions: {
      Acre: "o",
      Amapá: "o",
      Amazonas: "o",
      Bahia: "a",
      Ceará: "o",
      "Espírito Santo": "o",
      Maranhão: "o",
      Pará: "o",
      Paraíba: "a",
      Paraná: "o",
      Piauí: "o",
      "Rio de Janeiro": "o",
      "Rio Grande do Norte": "o",
      "Rio Grande do Sul": "o",
      Tocantins: "o",
      "Distrito Federal": "o",
    },
  },
  PT: { cities: { Porto: "o" }, regions: { Madeira: "a" } },
  EG: { cities: { Cairo: "o" } },
  IT: { regions: { Sicília: "a", Sardenha: "a" } },
  FR: { regions: { Córsega: "a" } },
};

// The article a French or Italian name starts with ("Le Havre", "Il Cairo", "L'Aquila").
const LEADING: Partial<Record<PlaceLanguage, RegExp>> = {
  fr: /^(le|la|les) |^(l')/i,
  it: /^(il|lo|la|i|gli|le) |^(l')/i,
};

/**
 * The article `name` takes in `language`, if any. A French or Italian name keeps the article it
 * starts with only where it is the language's own name for the place: as an exonym ("Il
 * Cairo"), in a country whose first language it is ("Le Havre", "La Spezia"), or in one that
 * also speaks it ("Le Locle", "Les Cèdres"). A foreign name that happens to start like one stays
 * whole ("a La Paz").
 */
export function placeArticle(input: {
  name: string;
  language: PlaceLanguage;
  level: "city" | "region";
  country: string;
  countryLanguages: readonly string[];
  listed: string;
  /** Whether GeoNames itself names the place in `language`. */
  ownName: boolean;
}): string | undefined {
  const { name, language, level, country, countryLanguages, listed, ownName } = input;
  if (language === "pt") {
    const table = PORTUGUESE[country]?.[level === "city" ? "cities" : "regions"];
    return table?.[name];
  }
  const leading = LEADING[language]?.exec(name);
  if (!leading) return undefined;
  const article = (leading[1] ?? leading[2] ?? "").toLowerCase();
  // DataForSEO writes the local name without accents, spaces or designator ("LaBelle", "La
  // Rioja Province"); only a different name is an exonym.
  const comparable = (written: string) => normalizePlaceName(written).replaceAll(" ", "");
  const local = parseDesignated(listed)?.core ?? listed;
  const exonym = comparable(name) !== comparable(local);
  // Where several languages are spoken, French and Italian share "la", "le" and "l'": the name
  // is the language's own when GeoNames names the place in it, or its article is the language's
  // alone ("Le Locle" is French in Switzerland, not Italian).
  const ownLanguage =
    countryLanguages[0] === language ||
    (countryLanguages.includes(language) && (ownName || DISTINCT[language]?.has(article)));
  return exonym || ownLanguage ? article : undefined;
}

const DISTINCT: Partial<Record<PlaceLanguage, ReadonlySet<string>>> = {
  fr: new Set(["le", "les"]),
  it: new Set(["il", "lo", "i", "gli"]),
};
