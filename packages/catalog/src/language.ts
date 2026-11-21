import { type CountryCode, getCountry, mainLanguage } from "@reranker/i18n/countries";
import { AppError } from "@reranker/schema";
import { type GeoTarget, MeasurementLanguage } from "@reranker/schema/measurement";
import regionalLanguages from "../data/regional-languages.json" with { type: "json" };
import { loadCountryGeo } from "./geo/load";
import { localPlaceArticle, localPlaceName, spokenPlaceName } from "./geo/resolve";
import { isGendered, type Noun, type PlaceName } from "./grammar";

/** What a language lacks for a question to be asked in it. */
export type LanguageGap =
  | "unsupported"
  | "no_templates"
  | "no_place_names"
  | "no_prompts"
  | "no_noun_gender";

/** A measurement that cannot be asked in a language yet: refused rather than asked in another. */
export class MeasurementLanguageError extends AppError {
  readonly language: string;
  readonly gap: LanguageGap;

  constructor(language: string, gap: LanguageGap, detail: string) {
    super("validation_failed", { detail, params: { language, gap } });
    this.language = language;
    this.gap = gap;
  }
}

function measured(language: string, where: string): MeasurementLanguage {
  const parsed = MeasurementLanguage.safeParse(language);
  if (!parsed.success) {
    throw new MeasurementLanguageError(language, "unsupported", `${where} speaks ${language}`);
  }
  return parsed.data;
}

/** The main language of a country as a whole. */
export function countryLanguage(country: CountryCode): MeasurementLanguage {
  return measured(mainLanguage(country), country);
}

const regional = regionalLanguages.places as Readonly<
  Record<string, Readonly<Record<string, string>>>
>;

/**
 * The language a business is measured in unless told otherwise: its place's main one, which in a
 * multilingual country is its region's ("fr" in Geneva and Montreal, "it" in Lugano), else its
 * country's. Sources are listed in data/regional-languages.json.
 */
export function placeLanguage(geo: GeoTarget): MeasurementLanguage {
  const places = regional[geo.country];
  if (places && geo.level !== "country") {
    const place = loadCountryGeo(geo.country).byKey.get(geo.key);
    const region = place?.regionKey ? loadCountryGeo(geo.country).byKey.get(place.regionKey) : null;
    const language =
      (place && places[place.locationCode]) ?? (region && places[region.locationCode]);
    if (language) return measured(language, geo.key);
  }
  return countryLanguage(geo.country);
}

const countryNames = new Map<MeasurementLanguage, Intl.DisplayNames>();

/** The country as people asking in `language` name it: "España", "Spain", "Espanha". */
export function countryName(country: CountryCode, language: MeasurementLanguage): string {
  // The registry already holds the Spanish names, from the same CLDR data.
  if (language === "es") return getCountry(country).name;
  let names = countryNames.get(language);
  if (!names) {
    names = new Intl.DisplayNames([language], { type: "region", fallback: "none" });
    countryNames.set(language, names);
  }
  const name = names.of(country);
  if (!name) {
    throw new MeasurementLanguageError(language, "no_place_names", `no name for ${country}`);
  }
  return name;
}

/**
 * The place a local question names, as people who speak its language write it: "New York" in
 * English where the display name reads "Nueva York", "München" in German. A town with no name
 * of its own in the language keeps its local one ("Corrales del Vino"), never a Spanish exonym.
 * Refused only when the location data was built without the language.
 */
export function placeName(geo: GeoTarget, language: MeasurementLanguage): string {
  if (geo.level === "country") return countryName(geo.country, language);
  if (language === "es") return spokenPlaceName(geo.name);
  const name = localPlaceName(geo, language);
  if (name !== null) return name;
  throw new MeasurementLanguageError(
    language,
    "no_place_names",
    `no ${language} name for ${geo.key}`,
  );
}

/** The place's name with the article it takes, for the slot grammar to fuse with its preposition. */
export function placeTerm(geo: GeoTarget, language: MeasurementLanguage): PlaceName {
  const text = placeName(geo, language);
  if (geo.level === "country" || language === "es") return { text };
  const article = localPlaceArticle(geo, language);
  return article ? { text, article } : { text };
}

/**
 * Templates in a gendered language agree with their noun, so a set in one needs the noun's
 * gender; without it the set is refused, never written as if the noun were masculine.
 */
export function requireNounGender(noun: Noun, language: MeasurementLanguage): Noun {
  if (isGendered(language) && typeof noun === "string") {
    throw new MeasurementLanguageError(
      language,
      "no_noun_gender",
      `the ${language} noun "${noun}" has no gender`,
    );
  }
  return noun;
}
