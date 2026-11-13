import type { Formats } from "use-intl/core";
import { billingFor, countryForLocale, getCountry, isMeasurable } from "./countries/index";
import { CURRENCIES, type CurrencyCode } from "./currencies";
import type { Locale } from "./locales";

// Dates belong to the customer's country, never to the server's zone, so server and client agree.
export function defaultTimeZone(locale: Locale): string {
  return getCountry(countryForLocale(locale)).timeZone;
}

// The currency a country is charged in; countries that cannot pay have none.
export function chargedCurrency(country: string): CurrencyCode | undefined {
  if (!isMeasurable(country)) return undefined;
  const billing = billingFor(country);
  return "currency" in billing ? billing.currency : undefined;
}

function localeCurrency(locale: Locale): CurrencyCode {
  const country = countryForLocale(locale);
  const currency = chargedCurrency(country);
  if (!currency) throw new Error(`No currency for the country of locale ${locale}: ${country}`);
  return currency;
}

export function getFormats(locale: Locale) {
  const currency = localeCurrency(locale);
  const digits = CURRENCIES[currency].displayFractionDigits;
  return {
    number: {
      money: {
        style: "currency",
        currency,
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
      },
    },
    // Fields instead of dateStyle: intl-messageformat merges these into its built-in "short" and
    // "long" date formats, and dateStyle cannot be combined with their fields ("{d, date, long}"
    // would fail). In es-CO these fields render exactly as dateStyle "long".
    dateTime: {
      short: { day: "numeric", month: "short", year: "numeric" },
      long: { day: "numeric", month: "long", year: "numeric" },
    },
  } as const satisfies Formats;
}
