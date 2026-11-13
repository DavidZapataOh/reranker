import type { Formats } from "use-intl/core";
import { profileForLocale } from "./countries/profiles";
import type { Locale } from "./locales";

// Dates belong to the customer's country, never to the server's zone, so server and client agree.
export function defaultTimeZone(locale: Locale): string {
  return profileForLocale(locale).timeZone;
}

// No money format: amounts reach messages as strings from formatMoney, which knows the viewer.
export function getFormats(_locale: Locale) {
  return {
    // Fields instead of dateStyle: intl-messageformat merges these into its built-in "short" and
    // "long" date formats, and dateStyle cannot be combined with their fields ("{d, date, long}"
    // would fail). In es-CO these fields render exactly as dateStyle "long".
    dateTime: {
      short: { day: "numeric", month: "short", year: "numeric" },
      long: { day: "numeric", month: "long", year: "numeric" },
    },
  } as const satisfies Formats;
}
