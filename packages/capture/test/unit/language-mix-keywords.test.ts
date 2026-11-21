import { categoryTerms, seedCategories } from "@reranker/catalog";
import { MeasurementLanguage } from "@reranker/schema/measurement";
import { describe, expect, test } from "vitest";
import lexicon from "../../data/common-words.json" with { type: "json" };
import {
  type KeywordContext,
  languageKeywords,
  languageVolumes,
  NEAR_ME,
  readsAs,
  sharesOf,
  words,
} from "../../src/language-mix/keywords";

const ALL = MeasurementLanguage.options;
const local = (main: KeywordContext["main"], place: string): KeywordContext => ({
  scope: "local",
  places: Object.fromEntries(ALL.map((l) => [l, place])),
  main,
});
const credited = (keywords: ReturnType<typeof languageKeywords>) =>
  Object.fromEntries([...keywords].map(([keyword, { language }]) => [keyword, language]));

describe("languageKeywords", () => {
  test("asks each term alone, beside the place and near me, in its own language", () => {
    const keywords = languageKeywords({ en: ["dentist"], es: ["dentista"] }, local("en", "Miami"));
    expect(credited(keywords)).toEqual({
      dentist: "en",
      "dentist miami": "en",
      "dentist near me": "en",
      dentista: "es",
      "dentista miami": "es",
      "dentista cerca de mi": "es",
    });
  });

  test("a keyword written alike in several languages counts for the main one, near me apart", () => {
    const terms = { en: ["restaurant"], fr: ["restaurant"], de: ["Restaurant"] };
    expect(credited(languageKeywords(terms, local("fr", "Montréal")))).toEqual({
      restaurant: "fr",
      "restaurant montréal": "fr",
      "restaurant near me": "en",
      "restaurant près de moi": "fr",
      "restaurant in meiner nähe": "de",
    });
  });

  test("a term made of another language's common words counts for neither second language", () => {
    // "garage" is English too: in Hialeah it is the English main language's, never French.
    const terms = { en: ["mechanic"], fr: ["garage", "garagiste"] };
    expect(credited(languageKeywords(terms, local("en", "Hialeah")))).toMatchObject({
      garage: "en",
      "garage hialeah": "en",
      "garage près de moi": "fr",
      garagiste: "fr",
    });
    // Where neither is the main language, it is left out.
    const lugano = credited(languageKeywords(terms, local("it", "Lugano")));
    expect(lugano.garage).toBeUndefined();
    expect(lugano.garagiste).toBe("fr");
  });

  test("a national category asks no place and no near me", () => {
    const keywords = languageKeywords(
      { en: ["online shop"], es: ["tienda online"], it: ["shop online"] },
      { scope: "national", places: {}, main: "es" },
    );
    expect(credited(keywords)).toEqual({ "online shop": "en", "tienda online": "es" });
  });

  test("skips keywords past Google Ads' 80 characters or 10 words", () => {
    const long = "a ".repeat(8).trim();
    const keywords = languageKeywords({ en: [long, "x".repeat(81)] }, local("en", "Miami"));
    expect([...keywords.keys()]).toEqual([long, `${long} miami`, `${long} near me`]);
  });

  test("every seed category is measured in each of its languages", () => {
    for (const category of seedCategories()) {
      const terms = categoryTerms(category);
      const keywords = languageKeywords(terms, local("es", "Madrid"));
      expect(new Set([...keywords.values()].map((k) => k.language)), category.key).toEqual(
        new Set(Object.keys(terms).filter((l) => (terms[l as keyof typeof terms] ?? []).length)),
      );
    }
  });
});

describe("readsAs", () => {
  test.each([
    ["garage", "fr", ["fr", "en", "de", "it"]],
    ["taller", "es", ["es", "en"]],
    ["garagiste", "fr", ["fr"]],
    ["zahnarzt", "de", ["de"]],
    ["comprar por internet", "es", ["es", "pt"]],
  ] as const)("%s reads as %j", (term, language, expected) => {
    expect([...readsAs(term, language, ALL)].sort()).toEqual([...expected].sort());
  });

  test("a word the lexicon was not built with could be any language", () => {
    expect(readsAs("zahnarztpraxis berlin", "de", ALL).size).toBe(ALL.length);
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
    { en: ["dentist", "restaurant"], es: ["dentista", "restaurante"], de: ["Restaurant"] },
    local("en", "Miami"),
  );

  test("adds up each language's searches", () => {
    expect(
      languageVolumes(
        keywords,
        [
          { keyword: "dentist near me", volume: 9900 },
          { keyword: "dentist miami", volume: 500 },
          { keyword: "dentista cerca de mí", volume: 880 },
          { keyword: "dentista miami", volume: 370 },
          { keyword: "dentista", volume: null },
          { keyword: "unrelated", volume: 1000 },
          { keyword: null, volume: 5 },
        ],
        "en",
      ),
    ).toEqual({ en: 10_400, es: 1250 });
  });

  test("a group Google reported for close terms in several languages counts once, for the main", () => {
    expect(
      languageVolumes(
        keywords,
        [
          { keyword: "restaurant near me", volume: 9900 },
          { keyword: "restaurant in meiner nähe", volume: 9900 },
          { keyword: "restaurante miami", volume: 14_800 },
          { keyword: "restaurant miami", volume: 14_800 },
        ],
        "en",
      ),
    ).toEqual({ en: 24_700 });
    // Without the main language among them, the group counts for neither.
    expect(
      languageVolumes(
        keywords,
        [
          { keyword: "restaurante cerca de mi", volume: 320 },
          { keyword: "restaurant in meiner nähe", volume: 320 },
        ],
        "en",
      ),
    ).toEqual({});
  });
});

describe("sharesOf", () => {
  test("gives each language its share to four decimals", () => {
    expect(sharesOf({ en: 10_400, es: 1250 })).toEqual({ en: 0.8927, es: 0.1073 });
    expect(sharesOf({ en: 10, es: 0 })).toEqual({ en: 1 });
  });

  test("is empty without searches", () => expect(sharesOf({})).toEqual({}));
});
