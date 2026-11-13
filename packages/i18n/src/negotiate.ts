import { match } from "@formatjs/intl-localematcher";
import Negotiator from "negotiator";
import { DEFAULT_LOCALE, hasLocale, LOCALES, type Locale } from "./locales";

// Real browsers send well under 200 characters; the cap bounds parsing work on hostile input.
const MAX_HEADER_LENGTH = 4096;

export function negotiateLocale(acceptLanguage: string | null | undefined): Locale {
  if (!acceptLanguage) return DEFAULT_LOCALE;
  try {
    const header = acceptLanguage.slice(0, MAX_HEADER_LENGTH);
    const languages = new Negotiator({ headers: { "accept-language": header } }).languages();
    const locale = match(languages, LOCALES, DEFAULT_LOCALE);
    return hasLocale(locale) ? locale : DEFAULT_LOCALE;
  } catch {
    // match() throws RangeError on tags that are not BCP 47, such as "*" or "es-".
    return DEFAULT_LOCALE;
  }
}
