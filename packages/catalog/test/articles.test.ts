import { describe, expect, test } from "vitest";
import { placeArticle } from "../scripts/articles.ts";

type Case = {
  name: string;
  language: "pt" | "fr" | "it";
  country: string;
  countryLanguages?: readonly string[];
  listed?: string;
  level?: "city" | "region";
  ownName?: boolean;
};
const article = ({ name, countryLanguages = [], listed = name, ...rest }: Case) =>
  placeArticle({ name, listed, countryLanguages, level: "city", ownName: false, ...rest });

describe("Portuguese articles the name leaves out", () => {
  test.each([
    ["Rio de Janeiro", "BR", "city", "o"],
    ["Rio de Janeiro", "BR", "region", "o"],
    ["Recife", "BR", "city", "o"],
    ["Bahia", "BR", "region", "a"],
    ["Paraíba", "BR", "region", "a"],
    ["Porto", "PT", "city", "o"],
    ["Madeira", "PT", "region", "a"],
    ["Cairo", "EG", "city", "o"],
  ] as const)("%s (%s %s) takes %s", (name, country, level, expected) =>
    expect(article({ name, language: "pt", country, level })).toBe(expected),
  );

  test.each([
    ["São Paulo", "BR", "city"],
    ["São Paulo", "BR", "region"],
    ["Minas Gerais", "BR", "region"],
    ["Lisboa", "PT", "city"],
    ["Bahia", "BR", "city"],
  ] as const)("%s (%s %s) takes none", (name, country, level) =>
    expect(article({ name, language: "pt", country, level })).toBeUndefined(),
  );
});

describe("French and Italian articles the name starts with", () => {
  test.each([
    [{ name: "Le Havre", language: "fr", country: "FR", countryLanguages: ["fr"] }, "le"],
    [{ name: "Les Ulis", language: "fr", country: "FR", countryLanguages: ["fr"] }, "les"],
    [{ name: "La Spezia", language: "it", country: "IT", countryLanguages: ["it"] }, "la"],
    [{ name: "L'Aquila", language: "it", country: "IT", countryLanguages: ["it"] }, "l'"],
    [
      { name: "Le Locle", language: "fr", country: "CH", countryLanguages: ["de", "fr", "it"] },
      "le",
    ],
    [{ name: "Les Cèdres", language: "fr", country: "CA", countryLanguages: ["en", "fr"] }, "les"],
    [
      {
        name: "Il Cairo",
        language: "it",
        country: "EG",
        countryLanguages: ["ar"],
        listed: "Cairo",
      },
      "il",
    ],
    [
      {
        name: "Le Caire",
        language: "fr",
        country: "EG",
        countryLanguages: ["ar"],
        listed: "Cairo",
      },
      "le",
    ],
  ] satisfies [Case, string][])("%o takes %s", (input, expected) =>
    expect(article(input)).toBe(expected),
  );

  test.each([
    // Another language's name that starts like an article.
    { name: "La Paz", language: "it", country: "BO", countryLanguages: ["es"] },
    { name: "Le Mars", language: "fr", country: "US", countryLanguages: ["en", "es"] },
    // French in Switzerland, not Italian: GeoNames has no Italian name and "le" is French.
    { name: "Le Locle", language: "it", country: "CH", countryLanguages: ["de", "fr", "it"] },
    // DataForSEO's unaccented, unspaced or designated listing of the same local name.
    {
      name: "La Concepción",
      language: "fr",
      country: "NI",
      countryLanguages: ["es"],
      listed: "La Concepcion",
    },
    {
      name: "La Belle",
      language: "it",
      country: "US",
      countryLanguages: ["en", "es"],
      listed: "LaBelle",
    },
    {
      name: "La Rioja",
      language: "fr",
      country: "AR",
      countryLanguages: ["es"],
      listed: "La Rioja Province",
    },
    { name: "Leipzig", language: "fr", country: "DE", countryLanguages: ["de"] },
  ] satisfies Case[])("%o takes none", (input) => expect(article(input)).toBeUndefined());

  test("an Italian name GeoNames gives in a multilingual country keeps its article", () =>
    expect(
      article({
        name: "La Chaux-de-Fonds",
        language: "it",
        country: "CH",
        countryLanguages: ["de", "fr", "it"],
        ownName: true,
      }),
    ).toBe("la"));
});
