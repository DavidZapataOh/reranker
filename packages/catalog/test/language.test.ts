import { MeasurementLanguage } from "@reranker/schema/measurement";
import { describe, expect, test } from "vitest";
import { getGeo } from "../src/geo/resolve";
import {
  countryLanguage,
  countryName,
  MeasurementLanguageError,
  placeName,
  placeTerm,
} from "../src/language";
import { instantiate } from "../src/variants";

describe("countryLanguage", () => {
  test.each([
    ["CO", "es"],
    ["MX", "es"],
    ["ES", "es"],
    ["US", "en"],
    ["BR", "pt"],
    ["FR", "fr"],
    ["DE", "de"],
    ["AT", "de"],
    ["IT", "it"],
  ] as const)("%s is measured in %s", (country, language) =>
    expect(countryLanguage(country)).toBe(language),
  );

  test("a main language outside the measured ones is a typed refusal", () => {
    expect(() => countryLanguage("NL")).toThrow(MeasurementLanguageError);
    expect(() => countryLanguage("NL")).toThrow(
      expect.objectContaining({ language: "nl", gap: "unsupported", code: "validation_failed" }),
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
    ["ES", "fr", "Espagne"],
    ["ES", "de", "Spanien"],
    ["ES", "it", "Spagna"],
    ["BR", "pt", "Brasil"],
  ] as const)("%s in %s is %s", (country, language, name) =>
    expect(countryName(country, language)).toBe(name),
  );

  test("every measured language names every measured country", () => {
    for (const language of MeasurementLanguage.options) {
      for (const country of ["CO", "US", "BR", "FR", "DE", "IT", "CH"] as const) {
        expect(countryName(country, language)).toMatch(/^\p{Lu}/u);
      }
    }
  });
});

describe("placeName", () => {
  test("Spanish names the city as people say it", () =>
    expect(placeName(getGeo("co-c1003659"), "es")).toBe("Bogotá"));

  test("a country is named in every language", () =>
    expect(placeName(getGeo("mx"), "en")).toBe("Mexico"));

  test.each([
    ["mx-c1010043", "en", "Mexico City"],
    ["mx-c1010043", "es", "Ciudad de México"],
    ["us-c1023191", "en", "New York"],
    ["us-c1023191", "es", "Nueva York"],
    ["co-c1003659", "en", "Bogotá"],
    ["co-c1003659", "pt", "Bogotá"],
    ["br-c1001773", "pt", "São Paulo"],
    ["br-c1001773", "en", "São Paulo"],
    ["br-c1001655", "pt", "Rio de Janeiro"],
    ["br-c1001655", "en", "Rio de Janeiro"],
    ["de-c1004234", "en", "Munich"],
    ["de-c1004234", "de", "München"],
    ["de-c1004234", "it", "Monaco di Baviera"],
    ["fr-c1006094", "fr", "Paris"],
    ["fr-c1006094", "en", "Paris"],
    ["gb-c1006886", "en", "London"],
    ["gb-c1006886", "fr", "Londres"],
    ["pt-c9198446", "pt", "Lisboa"],
    ["pt-c9198446", "en", "Lisbon"],
    ["us-c1015116", "en", "Miami"],
    ["us-c1016367", "en", "Chicago"],
    ["us-c1016367", "pt", "Chicago"],
    ["es-c1005451", "en", "Corrales del Vino"],
    ["es-c1005451", "de", "Corrales del Vino"],
    // Small Swiss towns: the local name, its accents and its German exonym; never "Entrelagos".
    ["ch-c1002890", "en", "Interlaken"],
    ["ch-c1002890", "fr", "Interlaken"],
    ["ch-c1003036", "en", "Delémont"],
    ["ch-c1003036", "de", "Delémont"],
    ["ch-c1003088", "fr", "Neuchâtel"],
    ["ch-c1003088", "de", "Neuenburg"],
    ["ch-c1003297", "de", "Zürich"],
    ["ch-c1003297", "en", "Zurich"],
  ] as const)("%s in %s is %s", (key, language, name) =>
    expect(placeName(getGeo(key), language)).toBe(name),
  );

  test.each([
    ["es-c1005421", "Sevilla"],
    ["mx-c1010058", "León"],
    ["es-c9212542", "A Coruña"],
    ["ar-r9246111", "Departamento de San Jerónimo"],
    ["es-r9047060", "Provincia de Córdoba"],
    ["es-c9212393", "Municipio de Madrid"],
    ["es-c9220037", "Municipio de Sevilla"],
    ["ar-r9198775", "Departamento Capital"],
    ["mx-c9221748", "Municipio de Lerma"],
    ["ve-c9241472", "Municipio Maneiro"],
    ["cr-c9221392", "Distrito Mata Redonda"],
    ["uy-c9212667", "Municipio B"],
    ["lt-c9251799", "Municipio del distrito de Kaunas"],
  ] as const)("%s reads %s in Spanish, never its English name", (key, name) =>
    expect(placeName(getGeo(key), "es")).toBe(name),
  );

  test.each([
    ["es-c9220037", "en", "Seville Municipality"],
    ["es-c9220037", "fr", "Municipalité de Séville"],
    ["es-c9220037", "it", "Comune di Siviglia"],
    ["es-c9220037", "pt", "Município de Sevilha"],
    ["ar-r9198775", "en", "Capital Department"],
    ["ar-r9198166", "de", "Partido Morón"],
    ["ca-c9252584", "fr", "Municipalité régionale de comté de Portneuf"],
  ] as const)("%s in %s takes the language's own designator: %s", (key, language, name) =>
    expect(placeName(getGeo(key), language)).toBe(name),
  );

  test("a region is named in the language too", () =>
    expect(placeName(getGeo("us-r21167"), "en")).toBe("New York"));

  test("a place the location data does not know is refused, never named in Spanish", () => {
    const unknown = { ...getGeo("co-c1003659"), key: "co-c9999999" };
    for (const language of ["en", "pt", "fr", "de", "it"] as const) {
      expect(() => placeName(unknown, language)).toThrow(
        expect.objectContaining({ language, gap: "no_place_names" }),
      );
    }
  });
});

describe("placeTerm", () => {
  const noun = { text: "dentista", gender: "m" } as const;
  const asked = (key: string, language: "pt" | "fr" | "it", template: string) =>
    instantiate(template, {
      place: placeTerm(getGeo(key), language),
      zone: null,
      country: "-",
      noun,
      language,
    });

  test.each([
    ["br-c1001655", "pt", "dentista em {lugar}", "dentista no Rio de Janeiro"],
    ["br-r20102", "pt", "dentista em {lugar}", "dentista no Rio de Janeiro"],
    ["br-r20088", "pt", "dentista em {lugar}", "dentista na Bahia"],
    ["br-c1001625", "pt", "dentista em {lugar}", "dentista no Recife"],
    ["pt-c1011759", "pt", "dentista em {lugar}", "dentista no Porto"],
    ["br-c1001773", "pt", "dentista em {lugar}", "dentista em São Paulo"],
    ["br-r20106", "pt", "dentista em {lugar}", "dentista em São Paulo"],
    ["fr-c1006262", "fr", "dentista à {lugar}", "dentista au Havre"],
    ["fr-c1006053", "fr", "dentista à {lugar}", "dentista aux Ulis"],
    ["ch-c1003084", "fr", "dentista à {lugar}", "dentista au Locle"],
    ["eg-c1005390", "fr", "dentista à {lugar}", "dentista au Caire"],
    ["eg-c1005390", "it", "dentista a {lugar}", "dentista al Cairo"],
    ["it-c9205063", "it", "dentista a {lugar}", "dentista alla Spezia"],
    ["it-c9199385", "it", "dentista a {lugar}", "dentista all'Aquila"],
    ["nl-c9063489", "it", "dentista a {lugar}", "dentista all'Aia"],
    ["sa-c1028879", "it", "dentista a {lugar}", "dentista alla Mecca"],
    // French, Spanish and American names Italian writes as they are.
    ["it-c9203622", "it", "dentista a {lugar}", "dentista a La Magdeleine"],
    ["it-c9203848", "it", "dentista a {lugar}", "dentista a La Thuile"],
    ["ch-c1003082", "it", "dentista a {lugar}", "dentista a La Chaux-de-Fonds"],
    ["mx-c1031260", "it", "dentista a {lugar}", "dentista a La Cruz de Elota"],
    ["us-c1015079", "it", "dentista a {lugar}", "dentista a La Belle"],
    ["eg-c1005390", "pt", "dentista em {lugar}", "dentista no Cairo"],
  ] as const)("%s in %s: %s reads %s", (key, language, template, written) =>
    expect(asked(key, language, template)).toBe(written),
  );

  test("a country and a Spanish name carry no article", () => {
    expect(placeTerm(getGeo("br"), "pt")).toEqual({ text: "Brasil" });
    expect(placeTerm(getGeo("br-c1001655"), "es")).toEqual({ text: "Río de Janeiro" });
  });
});
