import { MeasurementLanguage, type QuestionScope } from "@reranker/schema/measurement";
import lexicon from "../../data/common-words.json" with { type: "json" };

/** The noun first, then its synonyms, as people searching in each language write them. */
export type CategoryTerms = Partial<Record<MeasurementLanguage, readonly string[]>>;

/**
 * Each language's most searched way to ask for a place nearby without naming the city
 * ("zahnarzt in meiner nähe" 201K a month in Germany). Unlike a bare noun ("hotel", "garage"),
 * a keyword ending this way is written in exactly one language.
 */
export const NEAR_ME: Readonly<Record<MeasurementLanguage, string>> = {
  es: "cerca de mi",
  en: "near me",
  pt: "perto de mim",
  fr: "près de moi",
  de: "in meiner nähe",
  it: "vicino a me",
};

/** A word among a language's this many most frequent ones is common in it. */
export const COMMON_RANK = 10_000;

// Google Ads limits (https://docs.dataforseo.com/v3/keywords_data-google_ads-search_volume-live/).
const MAX_CHARS = 80;
const MAX_WORDS = 10;
// Terms this close are variants Google may group ("restaurants miami" and "restaurantes miami"
// both came back as 14,800).
const VARIANT_DISTANCE = 2;

// Sent as written, accents kept ("in meiner nähe" is not "nahe"); compared folded, as Google
// matches them.
const lower = (text: string) => text.normalize("NFC").toLowerCase().replace(/\s+/g, " ").trim();
const fold = (text: string) =>
  lower(text)
    .normalize("NFD")
    .replace(/\p{M}+/gu, "");

/** The folded words of a text, as the frequency lists are compared: "chambre d'hôte" → 3. */
export const words = (text: string): string[] =>
  fold(text)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

const vocabulary = new Set(lexicon.vocabulary);
const common = new Map(
  Object.entries(lexicon.common).map(([language, list]) => [language, new Set(list)]),
);

/**
 * The languages among `candidates` a term could be written in: its own, and every other one in
 * which all its words are common ("garage" is French, English, German and Italian). A word the
 * lexicon was not built with could be anything, so it makes the term any candidate's.
 */
export function readsAs(
  term: string,
  language: MeasurementLanguage,
  candidates: readonly MeasurementLanguage[],
): Set<MeasurementLanguage> {
  const list = words(term);
  if (list.length === 0 || list.some((word) => !vocabulary.has(word))) {
    return new Set([language, ...candidates]);
  }
  const out = new Set([language]);
  for (const other of candidates) {
    if (list.every((word) => common.get(other)?.has(word))) out.add(other);
  }
  return out;
}

/** The language a keyword's searches are credited to, and the term it asks for. */
export type LanguageKeyword = { language: MeasurementLanguage; term: string };

export interface KeywordContext {
  scope: QuestionScope;
  /** The place as people searching in each language write it; a language without one skips it. */
  places: Partial<Record<MeasurementLanguage, string>>;
  /** The place's main language, which a keyword written alike in several languages counts for. */
  main: MeasurementLanguage;
}

/**
 * The keywords whose searches are credited to one language, keyed by the text to send: each
 * term alone, beside the place and, for a local category, with the language's "near me" phrase.
 *
 * Google Ads volume is not language-specific, so a keyword that reads as several languages
 * ("hotel", "restaurant montreal", "garage hialeah") is credited to the place's main language
 * when it is one of them, and left out otherwise: a second language counts only searches
 * written unmistakably in it. A "near me" phrase is written in one language whatever the noun.
 */
export function languageKeywords(
  terms: CategoryTerms,
  { scope, places, main }: KeywordContext,
): Map<string, LanguageKeyword> {
  const candidates = MeasurementLanguage.options.filter((l) => (terms[l]?.length ?? 0) > 0);
  const found = new Map<
    string,
    { keyword: string; term: string; languages: Set<MeasurementLanguage> }
  >();
  const add = (keyword: string, term: string, languages: Iterable<MeasurementLanguage>) => {
    if (keyword.length > MAX_CHARS || keyword.split(" ").length > MAX_WORDS) return;
    const entry = found.get(fold(keyword)) ?? { keyword, term, languages: new Set() };
    for (const language of languages) entry.languages.add(language);
    found.set(fold(keyword), entry);
  };
  for (const language of candidates) {
    const place = places[language] && lower(places[language]);
    for (const term of terms[language] ?? []) {
      const t = lower(term);
      if (t === "") continue;
      const readers = readsAs(t, language, candidates);
      add(t, t, readers);
      if (scope === "local") {
        if (place) add(`${t} ${place}`, t, readers);
        add(`${t} ${NEAR_ME[language]}`, t, [language]);
      }
    }
  }
  const out = new Map<string, LanguageKeyword>();
  for (const { keyword, term, languages } of found.values()) {
    const [only] = languages;
    const language = languages.size === 1 ? only : languages.has(main) ? main : undefined;
    if (language) out.set(keyword, { language, term: fold(term) });
  }
  return out;
}

function withinDistance(a: string, b: string, max: number): boolean {
  if (Math.abs(a.length - b.length) > max) return false;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const substitution = (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1);
      current.push(Math.min((previous[j] ?? 0) + 1, (current[j - 1] ?? 0) + 1, substitution));
    }
    previous = current;
  }
  return (previous[b.length] ?? 0) <= max;
}

export type KeywordVolume = { keyword?: string | null; volume?: number | null };

/**
 * Monthly searches per language. Google groups close variants, even across languages ("restaurant
 * near me" and "restaurant in meiner nähe" for one noun), and reports the group's volume for each:
 * two keywords of close terms with the same volume are one group, counted for the main language
 * when it is one of them and for neither otherwise.
 */
export function languageVolumes(
  keywords: ReadonlyMap<string, LanguageKeyword>,
  rows: readonly KeywordVolume[],
  main: MeasurementLanguage,
): Partial<Record<MeasurementLanguage, number>> {
  const byFolded = new Map([...keywords].map(([keyword, entry]) => [fold(keyword), entry]));
  const counted: (LanguageKeyword & { keyword: string; volume: number })[] = [];
  for (const row of rows) {
    const keyword = row.keyword ? fold(row.keyword) : "";
    const entry = byFolded.get(keyword);
    if (entry && typeof row.volume === "number" && row.volume > 0) {
      counted.push({ ...entry, keyword, volume: row.volume });
    }
  }
  const merged = new Set<string>();
  for (const [i, a] of counted.entries()) {
    for (const b of counted.slice(i + 1)) {
      if (
        a.volume === b.volume &&
        a.language !== b.language &&
        withinDistance(a.term, b.term, VARIANT_DISTANCE)
      ) {
        if (a.language !== main) merged.add(a.keyword);
        if (b.language !== main) merged.add(b.keyword);
      }
    }
  }
  const volumes: Partial<Record<MeasurementLanguage, number>> = {};
  for (const { keyword, language, volume } of counted) {
    if (!merged.has(keyword)) volumes[language] = (volumes[language] ?? 0) + volume;
  }
  return volumes;
}

/** Each language's share of the searches, to four decimals; empty when there are none. */
export function sharesOf(
  volumes: Partial<Record<MeasurementLanguage, number>>,
): Partial<Record<MeasurementLanguage, number>> {
  const total = Object.values(volumes).reduce((sum, v) => sum + v, 0);
  if (total <= 0) return {};
  const shares: Partial<Record<MeasurementLanguage, number>> = {};
  for (const [language, volume] of Object.entries(volumes) as [MeasurementLanguage, number][]) {
    if (volume > 0) shares[language] = Math.round((volume / total) * 10_000) / 10_000;
  }
  return shares;
}
