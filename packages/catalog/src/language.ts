import { type CountryCode, getCountry, mainLanguage } from "@reranker/i18n/countries";
import { AppError } from "@reranker/schema";
import { type GeoTarget, MeasurementLanguage } from "@reranker/schema/measurement";
import { localPlaceName, spokenPlaceName } from "./geo/resolve";

/** What a language lacks for a question to be asked in it. */
export type LanguageGap = "unsupported" | "no_templates" | "no_place_names";

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

/** The language a business is measured in unless told otherwise: its country's main one. */
export function countryLanguage(country: CountryCode): MeasurementLanguage {
  const language = mainLanguage(country);
  const parsed = MeasurementLanguage.safeParse(language);
  if (!parsed.success) {
    throw new MeasurementLanguageError(language, "unsupported", `${country} speaks ${language}`);
  }
  return parsed.data;
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
