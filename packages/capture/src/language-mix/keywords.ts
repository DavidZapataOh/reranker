import { MeasurementLanguage, type QuestionScope } from "@reranker/schema/measurement";
import lexicon from "../../data/common-words.json" with { type: "json" };

/** The noun first, then its synonyms, as people searching in each language write them. */
export type CategoryTerms = Partial<Record<MeasurementLanguage, readonly string[]>>;

/**
 * Each language's most searched way to ask for a place nearby without naming the city
 * ("zahnarzt in meiner nähe" 201K a month in Germany). Unlike a bare noun ("hotel", "garage"),
 * a phrase ending this way is written in exactly one language.
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
// Google merges close variants across languages ("restaurants miami" and "restaurantes miami"
// both came back as 14,800), so two such keywords with the same volume count for neither.
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
 * Whether a term reads as `language` alone among `others`: some word of it is not common in
 * each of them. A word the lexicon was not built with fails, so an unreviewed term never counts.
 */
export function distinctive(
  term: string,
  language: MeasurementLanguage,
  others: Iterable<MeasurementLanguage>,
): boolean {
  const list = words(term);
  if (list.length === 0 || list.some((word) => !vocabulary.has(word))) return false;
  for (const other of others) {
    if (other === language) continue;
    const shared = common.get(other);
    if (shared && list.every((word) => shared.has(word))) return false;
  }
  return true;
}

/**
 * The keywords that tell each language's searches apart, keyed by the text to send.
 *
 * For a local category every language asks the same thing, each term followed by its "near me"
 * phrase, so the volumes compare like for like. A bare term or one beside the place is left
 * out: the city is written the same in most languages and many nouns are shared ("hotel",
 * "restaurant", "garage"), and Google counts their volume once for every language using them.
 * A national category has no "near me", so its terms are asked alone, only those `distinctive`.
 */
export function languageKeywords(
  terms: CategoryTerms,
  scope: QuestionScope,
): Map<string, MeasurementLanguage> {
  const languages = MeasurementLanguage.options.filter((l) => (terms[l]?.length ?? 0) > 0);
  const owners = new Map<string, { keyword: string; languages: Set<MeasurementLanguage> }>();
  for (const language of languages) {
    for (const term of terms[language] ?? []) {
      const t = lower(term);
      if (t === "") continue;
      if (scope === "national" && !distinctive(t, language, languages)) continue;
      const keyword = scope === "national" ? t : `${t} ${NEAR_ME[language]}`;
      if (keyword.length > MAX_CHARS || keyword.split(" ").length > MAX_WORDS) continue;
      const owner = owners.get(fold(keyword)) ?? { keyword, languages: new Set() };
      owner.languages.add(language);
      owners.set(fold(keyword), owner);
    }
  }
  const out = new Map<string, MeasurementLanguage>();
  for (const { keyword, languages: owned } of owners.values()) {
    const [only] = owned;
    if (owned.size === 1 && only) out.set(keyword, only);
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

/** Monthly searches per language, leaving out keywords Google merged across languages. */
export function languageVolumes(
  keywords: ReadonlyMap<string, MeasurementLanguage>,
  rows: readonly KeywordVolume[],
): Partial<Record<MeasurementLanguage, number>> {
  const byFolded = new Map([...keywords].map(([keyword, language]) => [fold(keyword), language]));
  const counted: { keyword: string; language: MeasurementLanguage; volume: number }[] = [];
  for (const row of rows) {
    const keyword = row.keyword ? fold(row.keyword) : "";
    const language = byFolded.get(keyword);
    if (language && typeof row.volume === "number" && row.volume > 0) {
      counted.push({ keyword, language, volume: row.volume });
    }
  }
  const merged = new Set<string>();
  for (const [i, a] of counted.entries()) {
    for (const b of counted.slice(i + 1)) {
      if (
        a.volume === b.volume &&
        a.language !== b.language &&
        withinDistance(a.keyword, b.keyword, VARIANT_DISTANCE)
      ) {
        merged.add(a.keyword).add(b.keyword);
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
