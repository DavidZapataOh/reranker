export const LOCALES = ["es-CO"] as const;

export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = LOCALES[0];

export function hasLocale(value: unknown): value is Locale {
  return LOCALES.includes(value as Locale);
}
