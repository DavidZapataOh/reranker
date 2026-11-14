import { hasLocale, type Locale, negotiateLocale } from "@reranker/i18n";

/**
 * Language of an email: the user's saved one, then the page the code was requested from, then the
 * browser's Accept-Language. The country never decides it; it only drives currency and billing.
 */
export function resolveEmailLocale({
  userLocale,
  pageLocale,
  acceptLanguage,
}: {
  userLocale?: string | null | undefined;
  pageLocale?: string | null | undefined;
  acceptLanguage?: string | null | undefined;
}): Locale {
  if (hasLocale(userLocale)) return userLocale;
  if (hasLocale(pageLocale)) return pageLocale;
  return negotiateLocale(acceptLanguage);
}
