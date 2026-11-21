import { countryLanguage } from "@reranker/catalog";
import type { CountryCode } from "@reranker/i18n/countries";
import type { MeasurementLanguage } from "@reranker/schema/measurement";

// When the country speaks none of the measured languages the measurement is refused later, where
// its questions are built; until then names and searches still need a language.
const HOUSE_LANGUAGE: MeasurementLanguage = "es";

/** The language a business in `country` is measured in unless told otherwise. */
export function languageOfCountry(country: CountryCode | null): MeasurementLanguage {
  if (country === null) return HOUSE_LANGUAGE;
  try {
    return countryLanguage(country);
  } catch {
    return HOUSE_LANGUAGE;
  }
}
