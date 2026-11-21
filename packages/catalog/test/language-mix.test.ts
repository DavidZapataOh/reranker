import type { CountryCode } from "@reranker/i18n/countries";
import { MeasurementLanguageRequest } from "@reranker/schema/measurement";
import { describe, expect, test } from "vitest";
import {
  decideLanguages,
  type LanguageMix,
  secondLanguageOf,
  unmeasuredMix,
} from "../src/language-mix";

const mix = (shares: LanguageMix["shares"], main: "es" | "en" | "de" = "en"): LanguageMix => ({
  shares,
  level: "city",
  source: "google_ads",
  asOf: "2026-11-20",
  second: secondLanguageOf(shares, main),
  degraded: null,
});

const decide = (
  country: CountryCode,
  shares: LanguageMix["shares"] | LanguageMix,
  extra: Partial<{
    site: ("es" | "en" | "pt" | "fr" | "de" | "it")[];
    owner: "es" | "en" | "pt" | "fr" | "de" | "it";
  }> = {},
) =>
  decideLanguages({
    country,
    mix: "degraded" in shares ? (shares as LanguageMix) : mix(shares as LanguageMix["shares"]),
    businessLanguages: extra.site ?? [],
    alsoServesIn: extra.owner ?? null,
  });

describe("secondLanguageOf", () => {
  test("takes the largest other language at or above a tenth of the searches", () => {
    expect(secondLanguageOf({ en: 0.8, es: 0.1, fr: 0.1 }, "en")).toEqual({
      kind: "second",
      language: "es",
      share: 0.1,
    });
    expect(secondLanguageOf({ de: 0.15, fr: 0.7, it: 0.15 }, "de")).toEqual({
      kind: "second",
      language: "fr",
      share: 0.7,
    });
  });

  test("leaves a language just under the threshold out", () => {
    expect(secondLanguageOf({ en: 0.9001, es: 0.0999 }, "en")).toEqual({ kind: "none" });
    expect(secondLanguageOf({}, "es")).toEqual({ kind: "none" });
  });
});

describe("decideLanguages", () => {
  test.each([
    ["CO", "es", "en"],
    ["US", "en", "es"],
    ["BR", "pt", "es"],
    ["FR", "fr", "en"],
    ["DE", "de", "en"],
    ["IT", "it", "en"],
  ] as const)(
    "%s is measured in %s alone, and in %s too when the owner serves in it",
    (country, main, other) => {
      expect(decide(country, { [main]: 0.97, [other]: 0.03 })).toEqual({
        main,
        secondary: null,
        languageShares: null,
      });
      expect(decide(country, { [main]: 0.97, [other]: 0.03 }, { owner: other })).toEqual({
        main,
        secondary: { language: other, reasons: ["owner"], share: 0.03, weighted: true },
        languageShares: { [main]: 0.97, [other]: 0.03 },
      });
    },
  );

  test("a Miami dentist is measured in Spanish too, weighted by its 11% of searches", () => {
    expect(decide("US", { en: 0.89, es: 0.11 })).toEqual({
      main: "en",
      secondary: { language: "es", reasons: ["search_share"], share: 0.11, weighted: true },
      languageShares: { en: 0.89, es: 0.11 },
    });
  });

  test("a Miami restaurant whose site says 'se habla español' weighs Spanish by its 2%", () => {
    expect(decide("US", { en: 0.98, es: 0.02 }, { site: ["es"] }).secondary).toEqual({
      language: "es",
      reasons: ["business_signal"],
      share: 0.02,
      weighted: true,
    });
  });

  test("a Montreal business is measured in French, the majority of its city's searches", () => {
    expect(decide("CA", { en: 0.32, fr: 0.68 }, { site: ["fr", "en"] })).toEqual({
      main: "en",
      secondary: {
        language: "fr",
        reasons: ["business_signal", "search_share"],
        share: 0.68,
        weighted: true,
      },
      languageShares: { en: 0.32, fr: 0.68 },
    });
  });

  test("in Switzerland one second language is chosen among several", () => {
    const geneva = { de: 0.12, fr: 0.7, it: 0.05, en: 0.13 };
    expect(decide("CH", geneva).secondary?.language).toBe("fr");
    // A site in Italian and English: the language with two reasons beats the larger share alone.
    expect(decide("CH", geneva, { site: ["en", "it"] }).secondary).toEqual({
      language: "en",
      reasons: ["business_signal", "search_share"],
      share: 0.13,
      weighted: true,
    });
    // The owner's word ranks first.
    expect(decide("CH", geneva, { site: ["en"], owner: "it" })).toEqual({
      main: "de",
      secondary: { language: "it", reasons: ["owner"], share: 0.05, weighted: true },
      languageShares: { de: 0.12, it: 0.05 },
    });
  });

  test("a second language without searches is reported on its own, not weighted", () => {
    expect(decide("US", { en: 1 }, { site: ["fr"] })).toEqual({
      main: "en",
      secondary: { language: "fr", reasons: ["business_signal"], share: 0, weighted: false },
      languageShares: null,
    });
  });

  test("an unmeasured mix keeps the owner's language but weights nothing", () => {
    expect(decide("US", unmeasuredMix("deadline"), { owner: "es" })).toEqual({
      main: "en",
      secondary: { language: "es", reasons: ["owner"], share: null, weighted: false },
      languageShares: null,
    });
    expect(decide("US", unmeasuredMix("unavailable"))).toEqual({
      main: "en",
      secondary: null,
      languageShares: null,
    });
  });

  test("the main language named by a signal or the owner changes nothing", () => {
    expect(decide("CO", { es: 1 }, { site: ["es"], owner: "es" }).secondary).toBeNull();
  });
});

describe("MeasurementLanguageRequest", () => {
  test("takes a measured language, or none", () => {
    expect(MeasurementLanguageRequest.parse({ alsoServesIn: "fr" })).toEqual({
      alsoServesIn: "fr",
    });
    expect(MeasurementLanguageRequest.parse({})).toEqual({ alsoServesIn: null });
  });

  test("refuses a language we do not measure in and unknown fields", () => {
    expect(MeasurementLanguageRequest.safeParse({ alsoServesIn: "nl" }).success).toBe(false);
    expect(MeasurementLanguageRequest.safeParse({ alsoServesIn: "es", x: 1 }).success).toBe(false);
  });
});
