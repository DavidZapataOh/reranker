import { describe, expect, test } from "vitest";
import { languageKeywords, languageVolumes, sharesOf } from "../../src/language-mix/keywords";

const miami = { en: "Miami", es: "Miami" };

describe("languageKeywords", () => {
  test("asks each term alone, beside the place and near me, in its own language", () => {
    const keywords = languageKeywords({ en: ["dentist"], es: ["dentista"] }, miami);
    expect(Object.fromEntries(keywords)).toEqual({
      dentist: "en",
      "dentist miami": "en",
      "dentist near me": "en",
      dentista: "es",
      "dentista miami": "es",
      "dentista cerca de mi": "es",
    });
  });

  test("leaves out a keyword written the same in two languages", () => {
    const keywords = languageKeywords({ en: ["Hotel"], es: ["hotel"], de: ["Hotel"] }, miami);
    expect(Object.fromEntries(keywords)).toEqual({
      "hotel near me": "en",
      "hotel cerca de mi": "es",
      "hotel in meiner nähe": "de",
    });
  });

  test("sends accents as written and treats them as Google does when comparing", () => {
    const keywords = languageKeywords(
      { fr: ["garagiste"], pt: ["mecânico"], es: ["mecanico"] },
      {},
    );
    expect(keywords.get("garagiste près de moi")).toBe("fr");
    // "mecânico" and "mecanico" fold to one keyword, so both languages lose it.
    expect([...keywords.keys()].filter((k) => k.startsWith("mec") && !k.includes(" "))).toEqual([]);
  });

  test("skips keywords past Google Ads' 80 characters or 10 words", () => {
    const long = "a ".repeat(9).trim();
    const keywords = languageKeywords({ en: [long, "x".repeat(81)] }, { en: "Miami" });
    expect([...keywords.keys()]).toEqual([long, `${long} miami`]);
  });
});

describe("languageVolumes", () => {
  const keywords = languageKeywords(
    { en: ["dentist", "restaurants"], es: ["dentista", "restaurantes"] },
    miami,
  );

  test("adds up each language's searches", () => {
    expect(
      languageVolumes(keywords, [
        { keyword: "dentist near me", volume: 9900 },
        { keyword: "dentist miami", volume: 500 },
        { keyword: "dentista cerca de mí", volume: 880 },
        { keyword: "dentista miami", volume: 370 },
        { keyword: "dentista", volume: null },
        { keyword: "unrelated", volume: 1000 },
        { keyword: null, volume: 5 },
      ]),
    ).toEqual({ en: 10_400, es: 1250 });
  });

  test("drops close variants Google merged across languages", () => {
    expect(
      languageVolumes(keywords, [
        { keyword: "restaurants miami", volume: 14_800 },
        { keyword: "restaurantes miami", volume: 14_800 },
        { keyword: "dentist", volume: 300 },
        { keyword: "dentista", volume: 300 },
        { keyword: "restaurants near me", volume: 550_000 },
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
