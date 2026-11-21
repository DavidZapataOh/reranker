import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { guardFallback, type Recording } from "../scripts/guard-fallback.ts";

const recorded = (language: string) =>
  JSON.parse(
    readFileSync(
      new URL(`./fixtures/recorded/generation/generation-${language}.json`, import.meta.url),
      "utf8",
    ),
  ) as Recording;

// Real output of both providers for the six intents of the five local seed categories, recorded
// with the generation-record workflow. What the guards still reject is listed so any change to
// them shows up here: the remaining category-noun rejections name the business by a word search
// volume does not back as a synonym, and the qualifier ones drift into another intent.
test.each([
  ["es", 696, { qualifier: 13, category_noun: 8 }],
  ["en", 684, { category_noun: 85, qualifier: 25, proper_name: 1 }],
  ["pt", 612, { qualifier: 22, category_noun: 13, proper_name: 1 }],
  ["fr", 638, { qualifier: 19, category_noun: 64, placeholder: 2, proper_name: 1 }],
  ["it", 672, { qualifier: 9, category_noun: 16, proper_name: 1 }],
  ["de", 660, { qualifier: 7, category_noun: 26 }],
])("recorded %s paraphrases: no set falls back to templates", (language, paraphrases, rejected) => {
  const result = guardFallback(recorded(language));
  expect(result.paraphrases).toBe(paraphrases);
  expect(result.rejected).toEqual(rejected);
  expect(result.fallbacks).toBe(0);
});
