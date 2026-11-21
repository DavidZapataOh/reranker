/**
 * Builds data/common-words.json: for every word the category terms are written with, the
 * measured languages it is among the 10,000 most frequent words of. A term made only of words
 * common in another language ("garage", "pizzeria", "shop online") counts that language's
 * searches too, so the language mix cannot credit it to one.
 *
 * Source: Hermit Dave's FrequencyWords, OpenSubtitles 2018 (CC BY-SA 4.0, see NOTICE).
 * Usage: pnpm --filter @reranker/capture common-words:build
 */
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { categoryTerms, seedCategories } from "@reranker/catalog";
import { MeasurementLanguage } from "@reranker/schema/measurement";
import { COMMON_RANK, NEAR_ME, words } from "../src/language-mix/keywords";

const COMMIT = "525f9b560de45753a5ea01069454e72e9aa541c6";
const url = (language: string) =>
  `https://raw.githubusercontent.com/hermitdave/FrequencyWords/${COMMIT}/content/2018/${language}/${language}_50k.txt`;

const vocabulary = new Set<string>();
for (const category of seedCategories()) {
  for (const list of Object.values(categoryTerms(category))) {
    for (const term of list) for (const word of words(term)) vocabulary.add(word);
  }
}
for (const phrase of Object.values(NEAR_ME)) for (const word of words(phrase)) vocabulary.add(word);

const sources: { language: string; url: string; sha256: string }[] = [];
const common: Record<string, string[]> = {};
for (const language of MeasurementLanguage.options) {
  const response = await fetch(url(language));
  if (!response.ok) throw new Error(`${url(language)} answered ${response.status}`);
  const text = await response.text();
  sources.push({
    language,
    url: url(language),
    sha256: createHash("sha256").update(text).digest("hex"),
  });
  const top = new Set(
    text
      .split("\n")
      .slice(0, COMMON_RANK)
      .flatMap((line) => words(line.split(" ")[0] ?? "")),
  );
  common[language] = [...vocabulary].filter((word) => top.has(word)).sort();
}

writeFileSync(
  new URL("../data/common-words.json", import.meta.url),
  `${JSON.stringify({ sources, rank: COMMON_RANK, vocabulary: [...vocabulary].sort(), common }, null, 2)}\n`,
);
console.log(
  `${vocabulary.size} words; ${Object.entries(common)
    .map(([language, list]) => `${language} ${list.length}`)
    .join(", ")}`,
);
