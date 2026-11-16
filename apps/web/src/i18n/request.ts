import { DEFAULT_LOCALE, getFormats } from "@reranker/i18n";
import { countryForLocale, getCountry } from "@reranker/i18n/countries";
import { getRequestConfig } from "next-intl/server";

export const formats = getFormats(DEFAULT_LOCALE);

// One locale and no locale routing: nothing here reads the request, so every page stays static.
export default getRequestConfig(async () => ({
  locale: DEFAULT_LOCALE,
  messages: (await import(`@reranker/i18n/messages/${DEFAULT_LOCALE}.json`)).default,
  timeZone: getCountry(countryForLocale(DEFAULT_LOCALE)).timeZone,
  formats,
}));
