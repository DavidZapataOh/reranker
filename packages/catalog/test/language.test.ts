import { describe, expect, test } from "vitest";
import { getGeo } from "../src/geo/resolve";
import { countryLanguage, countryName, MeasurementLanguageError, placeName } from "../src/language";

describe("countryLanguage", () => {
  test.each([
    ["CO", "es"],
    ["MX", "es"],
    ["ES", "es"],
    ["US", "en"],
    ["BR", "pt"],
  ] as const)("%s is measured in %s", (country, language) =>
    expect(countryLanguage(country)).toBe(language),
  );

  test("a main language outside the measured ones is a typed refusal", () => {
    expect(() => countryLanguage("FR")).toThrow(MeasurementLanguageError);
    expect(() => countryLanguage("FR")).toThrow(
      expect.objectContaining({ language: "fr", gap: "unsupported", code: "validation_failed" }),
    );
  });
});

describe("countryName", () => {
  test.each([
    ["ES", "es", "España"],
    ["ES", "en", "Spain"],
    ["ES", "pt", "Espanha"],
    ["MX", "en", "Mexico"],
    ["US", "es", "Estados Unidos"],
    ["US", "en", "United States"],
  ] as const)("%s in %s is %s", (country, language, name) =>
    expect(countryName(country, language)).toBe(name),
  );
});

describe("placeName", () => {
  test("Spanish names the city as people say it", () =>
    expect(placeName(getGeo("co-c1003659"), "es")).toBe("Bogotá"));

  test("a country is named in every language", () =>
    expect(placeName(getGeo("mx"), "en")).toBe("Mexico"));

  test("a city without a name in the language is refused, never named in Spanish", () => {
    for (const language of ["en", "pt"] as const) {
      expect(() => placeName(getGeo("co-c1003659"), language)).toThrow(
        expect.objectContaining({ language, gap: "no_place_names" }),
      );
    }
  });
});
