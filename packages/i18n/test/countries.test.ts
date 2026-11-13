/// <reference lib="esnext.intl" />
/// <reference lib="esnext.temporal" />
// Node 26 ships Temporal and Intl.Locale#getTimeZones; the package lib stays at es2024.

import { describe, expect, test } from "vitest";
import {
  billingFor,
  buildCountries,
  COUNTRIES,
  countryForLocale,
  DEFAULT_COUNTRY_CODE,
  getCountry,
  isMeasurable,
  measurableCountries,
  type ProviderCoverage,
} from "../src/countries";
import { PROVIDER_COVERAGE } from "../src/countries/generated";
import type { Locale } from "../src/locales";

describe("country registry", () => {
  test("registry lookups", () => {
    expect(DEFAULT_COUNTRY_CODE).toBe("CO");
    expect(countryForLocale("es-CO")).toBe("CO");
    expect(() => getCountry("XX")).toThrow("Unknown country: XX");
    expect(getCountry("CO").legalEntity.taxId.value).toBe("902091972-5");
    expect(getCountry("CO").billing.tax.vatStandardRateBps).toBe(1900);
  });

  test("a locale resolves only to the country of its region", () => {
    expect(() => countryForLocale("es-ES" as Locale)).toThrow("No country for locale: es-ES");
    expect(() => countryForLocale("es" as Locale)).toThrow("No country for locale: es");
  });

  test("measurable countries cover the providers' lists except Cuba", () => {
    const codes = measurableCountries().map((country) => country.code);
    expect(codes).toEqual(expect.arrayContaining(["CO", "MX", "ES", "US", "BR", "NI", "VE"]));
    expect(codes).not.toContain("CU");
    expect(isMeasurable("CU")).toBe(false);
    expect(isMeasurable("XX")).toBe(false);
    expect(new Set(codes).size).toBe(codes.length);
  });

  test("Venezuela is measured without ChatGPT and Nicaragua with every engine", () => {
    expect(isMeasurable("VE")).toBe(true);
    expect(getCountry("VE").engines).not.toContain("chatgpt");
    expect(isMeasurable("NI")).toBe(true);
    expect(getCountry("NI").engines).toEqual(PROVIDER_COVERAGE.NI.engines);
    expect(getCountry("NI").engines).toContain("chatgpt");
  });

  test("policy applies even when a provider starts covering a country", () => {
    const everyEngine: ProviderCoverage = {
      name: "Prueba",
      timeZone: "America/Caracas",
      dataforseoLocationCode: 1,
      engines: ["chatgpt", "gemini", "google-ai-overview", "perplexity"],
    };
    const built = buildCountries({ CU: everyEngine, VE: everyEngine, CO: everyEngine });
    expect(Object.keys(built)).toEqual(["VE"]);
    expect(built.VE?.engines).toEqual(["gemini", "google-ai-overview", "perplexity"]);
    expect(built.VE?.billing).toEqual({ blocked: true });
    expect(built.VE?.providers).not.toHaveProperty("brightdata");
  });

  test("time zones follow each country's capital", () => {
    const zones = Object.fromEntries(
      ["BR", "AU", "CA", "US", "MX", "ES", "CO"].map((code) => [code, getCountry(code).timeZone]),
    );
    expect(zones).toEqual({
      BR: "America/Sao_Paulo",
      AU: "Australia/Sydney",
      CA: "America/Toronto",
      US: "America/New_York",
      MX: "America/Mexico_City",
      ES: "Europe/Madrid",
      CO: "America/Bogota",
    });
  });

  test("every time zone belongs to its own country", () => {
    // CLDR lists legacy aliases (Asia/Saigon), so zones are compared as Temporal does.
    const sameZone = (a: string, b: string) => {
      const instant = Temporal.Instant.fromEpochMilliseconds(0);
      return instant.toZonedDateTimeISO(a).equals(instant.toZonedDateTimeISO(b));
    };
    const foreign = measurableCountries().filter((country) => {
      const own = new Intl.Locale(`und-${country.code}`).getTimeZones() ?? [];
      return !own.some((zone) => sameZone(zone, country.timeZone));
    });
    expect(foreign.map((country) => `${country.code} ${country.timeZone}`)).toEqual([]);
    expect(getCountry("VN").timeZone).toBe("Asia/Ho_Chi_Minh");
  });

  test("Colombia's hand-written provider data matches the official lists", () => {
    const co = getCountry("CO");
    expect(co.providers.dataforseo.locationCode).toBe(PROVIDER_COVERAGE.CO.dataforseoLocationCode);
    expect(co.providers.brightdata.country).toBe(PROVIDER_COVERAGE.CO.brightdataCountry);
    expect(co.timeZone).toBe(PROVIDER_COVERAGE.CO.timeZone);
    expect(co.engines).toEqual(PROVIDER_COVERAGE.CO.engines);
  });

  test("every other entry is built from its provider coverage", () => {
    for (const [code, country] of Object.entries(COUNTRIES)) {
      expect(country.code).toBe(code);
      expect(country.locales).toEqual(["es-CO"]);
      expect(country.defaultLocale).toBe("es-CO");
      expect(country.geoData).toBe(`${code.toLowerCase()}-2026.11`);
      if (code === "CO") continue;
      const coverage = PROVIDER_COVERAGE[code as keyof typeof PROVIDER_COVERAGE];
      expect(country.name).toBe(coverage.name);
      expect(country.timeZone).toBe(coverage.timeZone);
      expect(country.providers.dataforseo.locationCode).toBe(coverage.dataforseoLocationCode);
      if ("brightdataCountry" in coverage) {
        expect(country.providers).toHaveProperty("brightdata.country", coverage.brightdataCountry);
      } else {
        expect(country.providers).not.toHaveProperty("brightdata");
      }
      expect(country).not.toHaveProperty("commercialContact");
    }
  });

  test("cold email is allowed only in Colombia", () => {
    expect(getCountry("CO").commercialContact.coldEmailAllowed).toBe(true);
    const others = measurableCountries().filter(
      (country) => "commercialContact" in country && country.code !== "CO",
    );
    expect(others).toEqual([]);
  });
});

describe("billing", () => {
  test("Colombia bills with Wompi in COP", () => {
    expect(billingFor("CO")).toMatchObject({ provider: "wompi", currency: "COP" });
  });

  test("the euro area pays Paddle in EUR and the rest in USD", () => {
    expect(billingFor("ES")).toEqual({ provider: "paddle", currency: "EUR" });
    expect(billingFor("BG")).toEqual({ provider: "paddle", currency: "EUR" });
    expect(billingFor("MX")).toEqual({ provider: "paddle", currency: "USD" });
    expect(billingFor("US")).toEqual({ provider: "paddle", currency: "USD" });
    expect(billingFor("DK")).toEqual({ provider: "paddle", currency: "USD" });
  });

  test.each(["AD", "MC", "ME", "SM", "VA"])(
    "%s uses the euro as its official currency and pays Paddle in EUR",
    (code) => {
      expect(billingFor(code)).toEqual({ provider: "paddle", currency: "EUR" });
    },
  );

  test("Cuba, Venezuela, Nicaragua and Paddle's unsupported countries cannot pay", () => {
    for (const code of ["CU", "VE", "NI", "AF", "IR", "ZW", "RU", "CW"]) {
      expect(billingFor(code)).toEqual({ blocked: true });
    }
  });

  test("an unknown country has no billing", () => {
    expect(() => billingFor("XX")).toThrow("Unknown country: XX");
  });
});
