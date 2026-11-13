import { LOCALES } from "@reranker/i18n";
import { COUNTRIES, getCountry } from "@reranker/i18n/countries";
import { describe, expect, test } from "vitest";
import { CountryConfig } from "../src/country";
import { CURRENCIES } from "../src/currencies";

const co = getCountry("CO");

describe("CountryConfig", () => {
  test("every registered country validates", () => {
    for (const country of Object.values(COUNTRIES)) {
      expect(CountryConfig.safeParse(country).error).toBeUndefined();
    }
  });

  test("CO currency exists in CURRENCIES", () => {
    expect(co.billing.currency in CURRENCIES).toBe(true);
  });

  test("locales are known and time zones are valid for Intl", () => {
    for (const country of Object.values(COUNTRIES)) {
      for (const locale of country.locales) expect(LOCALES).toContain(locale);
      expect(() => new Intl.DateTimeFormat("es-CO", { timeZone: country.timeZone })).not.toThrow();
    }
  });

  test("rejects an invalid time zone and an unknown payment provider", () => {
    expect(CountryConfig.safeParse({ ...co, timeZone: "Mars/Base" }).success).toBe(false);
    expect(
      CountryConfig.safeParse({ ...co, billing: { ...co.billing, provider: "stripe" } }).success,
    ).toBe(false);
  });

  test("Paddle bills only in EUR or USD and a blocked country carries nothing else", () => {
    const mx = getCountry("MX");
    expect(
      CountryConfig.safeParse({ ...mx, billing: { provider: "paddle", currency: "COP" } }).success,
    ).toBe(false);
    expect(
      CountryConfig.safeParse({ ...mx, billing: { blocked: true, provider: "paddle" } }).success,
    ).toBe(false);
    expect(CountryConfig.safeParse({ ...mx, billing: { blocked: false } }).success).toBe(false);
  });

  test("rejects out-of-contract Colombian billing", () => {
    const billing = co.billing;
    const variants = [
      { ...billing, currency: "USD" },
      { ...billing, tax: { ...billing.tax, regime: "us_irs" } },
      { ...billing, tax: { ...billing.tax, vatStandardRateBps: 10_001 } },
      { ...billing, tax: { ...billing.tax, vatStandardRateBps: 19.5 } },
      { ...billing, payments: { ...billing.payments, methods: ["cash"] } },
      { ...billing, invoicing: { provider: "siigo" } },
    ];
    for (const variant of variants) {
      expect(CountryConfig.safeParse({ ...co, billing: variant }).success).toBe(false);
    }
  });

  test("rejects malformed measurable data", () => {
    const variants = [
      { ...co, code: "col" },
      { ...co, locales: ["en-US"] },
      { ...co, defaultLocale: "es-CO", locales: [] },
      { ...co, engines: ["chatgpt", "chatgpt"] },
      { ...co, engines: ["bing"] },
      { ...co, geoData: "colombia" },
      { ...co, providers: { ...co.providers, dataforseo: { locationCode: -1 } } },
      { ...co, unknownField: true },
    ];
    for (const variant of variants) {
      expect(CountryConfig.safeParse(variant).success).toBe(false);
    }
  });

  test("rejects malformed commercial contact rules", () => {
    const contact = co.commercialContact;
    const variants = [
      { ...contact, windows: [{ days: [8], from: "07:00", to: "19:00" }] },
      { ...contact, windows: [{ days: [1], from: "24:00", to: "19:00" }] },
      { ...contact, windows: [{ days: [1], from: "19:00", to: "07:00" }] },
      { ...contact, coldEmailAllowed: false },
    ];
    for (const variant of variants) {
      expect(CountryConfig.safeParse({ ...co, commercialContact: variant }).success).toBe(false);
    }
  });

  test("commercial contact windows open before they close", () => {
    for (const w of co.commercialContact.windows) expect(w.from < w.to).toBe(true);
  });
});
