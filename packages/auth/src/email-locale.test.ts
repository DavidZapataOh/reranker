import { DEFAULT_LOCALE } from "@reranker/i18n";
import { describe, expect, test } from "vitest";
import { resolveEmailLocale } from "./email-locale";

describe("resolveEmailLocale", () => {
  test("prefers the language saved on the user", () => {
    expect(
      resolveEmailLocale({ userLocale: "es-CO", pageLocale: "en", acceptLanguage: "en-US" }),
    ).toBe("es-CO");
  });

  test("falls back to the page language, then Accept-Language, then the default", () => {
    expect(resolveEmailLocale({ pageLocale: "es-CO", acceptLanguage: "fr" })).toBe("es-CO");
    expect(resolveEmailLocale({ acceptLanguage: "es-MX,es;q=0.9" })).toBe("es-CO");
    expect(resolveEmailLocale({})).toBe(DEFAULT_LOCALE);
  });

  test("ignores values that are not an active locale", () => {
    expect(resolveEmailLocale({ userLocale: "en", pageLocale: "xx", acceptLanguage: "es" })).toBe(
      "es-CO",
    );
    expect(
      resolveEmailLocale({ userLocale: null, pageLocale: undefined, acceptLanguage: null }),
    ).toBe(DEFAULT_LOCALE);
    expect(resolveEmailLocale({ acceptLanguage: "*" })).toBe(DEFAULT_LOCALE);
  });
});
