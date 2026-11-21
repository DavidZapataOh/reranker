import { categoryTerms, seedCategories } from "@reranker/catalog";
import { MeasurementLanguage } from "@reranker/schema/measurement";
import { describe, expect, test } from "vitest";
import lexicon from "../../data/common-words.json" with { type: "json" };
import {
  distinctive,
  languageKeywords,
  languageVolumes,
  NEAR_ME,
  sharesOf,
  words,
} from "../../src/language-mix/keywords";

const ALL = MeasurementLanguage.options;

describe("languageKeywords", () => {
  test("a local category asks every term followed by its language's near-me phrase", () => {
    const keywords = languageKeywords({ en: ["dentist"], es: ["dentista"] }, "local");
    expect(Object.fromEntries(keywords)).toEqual({
      "dentist near me": "en",
      "dentista cerca de mi": "es",
    });
  });

  test("a noun shared by several languages still tells them apart near me", () => {
    // "garage" and "hotel" alone would credit every language that writes them.
    const keywords = languageKeywords(
      { en: ["Hotel", "garage"], fr: ["hôtel", "garage"], de: ["Hotel"] },
      "local",
    );
    expect(Object.fromEntries(keywords)).toEqual({
      "hotel near me": "en",
      "garage near me": "en",
      "hôtel près de moi": "fr",
      "garage près de moi": "fr",
      "hotel in meiner nähe": "de",
    });
  });

  test("a national category asks only the terms that read as one language", () => {
    const keywords = languageKeywords(
      { en: ["online shop"], es: ["tienda online"], it: ["negozio online", "shop online"] },
      "national",
    );
    expect(Object.fromEntries(keywords)).toEqual({
      "online shop": "en",
      "tienda online": "es",
      "negozio online": "it",
    });
  });

  test("skips keywords past Google Ads' 80 characters or 10 words", () => {
    const long = "a ".repeat(8).trim();
    const keywords = languageKeywords({ en: [long, "x".repeat(81)] }, "local");
    expect([...keywords.keys()]).toEqual([`${long} near me`]);
  });

  test("no seed category asks a keyword in the wrong language or in two", () => {
    for (const category of seedCategories()) {
      const terms = categoryTerms(category);
      const keywords = languageKeywords(terms, category.defaultScope);
      for (const [keyword, language] of keywords) {
        const asked =
          category.defaultScope === "local"
            ? keyword.endsWith(` ${NEAR_ME[language]}`)
            : distinctive(keyword, language, ALL);
        expect(asked, `${category.key}: ${keyword}`).toBe(true);
      }
      // Every language of a seed category is measured.
      expect(new Set(keywords.values()), category.key).toEqual(
        new Set(Object.keys(terms).filter((l) => (terms[l as keyof typeof terms] ?? []).length)),
      );
    }
  });
});

describe("distinctive", () => {
  test.each([
    ["garage", "fr", false],
    ["zahnarzt", "de", true],
    ["taller", "es", false],
    ["garagiste", "fr", true],
    ["comprar por internet", "es", false],
    ["boutique en ligne", "fr", true],
  ] as const)("%s reads as %s alone: %s", (term, language, expected) => {
    expect(distinctive(term, language, ALL)).toBe(expected);
  });

  test("a word the lexicon was not built with never counts", () => {
    expect(distinctive("zahnarztpraxis berlin", "de", ALL)).toBe(false);
  });

  test("the lexicon covers every word of every seed term and near-me phrase", () => {
    const vocabulary = new Set(lexicon.vocabulary);
    for (const category of seedCategories()) {
      for (const list of Object.values(categoryTerms(category))) {
        for (const term of list) {
          for (const word of words(term)) expect(vocabulary, `${term}: ${word}`).toContain(word);
        }
      }
    }
    for (const phrase of Object.values(NEAR_ME)) {
      for (const word of words(phrase)) expect(vocabulary).toContain(word);
    }
  });

  test("each near-me phrase differs from every other language's", () => {
    const phrases = Object.values(NEAR_ME).map((p) => words(p).join(" "));
    expect(new Set(phrases).size).toBe(phrases.length);
  });
});

describe("languageVolumes", () => {
  const keywords = languageKeywords(
    { en: ["dentist", "restaurant"], es: ["dentista", "restaurante"] },
    "local",
  );

  test("adds up each language's searches", () => {
    expect(
      languageVolumes(keywords, [
        { keyword: "dentist near me", volume: 9900 },
        { keyword: "restaurant near me", volume: 500 },
        { keyword: "dentista cerca de mí", volume: 880 },
        { keyword: "restaurante cerca de mi", volume: 370 },
        { keyword: "dentista", volume: null },
        { keyword: "unrelated", volume: 1000 },
        { keyword: null, volume: 5 },
      ]),
    ).toEqual({ en: 10_400, es: 1250 });
  });

  test("drops close variants Google merged across languages", () => {
    const merged = new Map([
      ["restaurants miami", "en"],
      ["restaurantes miami", "es"],
      ["restaurant near me", "en"],
    ] as const);
    expect(
      languageVolumes(merged, [
        { keyword: "restaurants miami", volume: 14_800 },
        { keyword: "restaurantes miami", volume: 14_800 },
        { keyword: "restaurant near me", volume: 550_000 },
      ]),
    ).toEqual({ en: 550_000 });
  });
});

describe("sharesOf", () => {
  test("gives each language its share to four decimals", () => {
    expect(sharesOf({ en: 10_400, es: 1250 })).toEqual({ en: 0.8927, es: 0.1073 });
    expect(sharesOf({ en: 10, es: 0 })).toEqual({ en: 1 });
  });

  test("is empty without searches", () => expect(sharesOf({})).toEqual({}));
});
