import { type GeoLevel, type GeoTarget, MeasurementLanguage } from "@reranker/schema/measurement";
import type { LanguageShares } from "@reranker/stats";
import { placeLanguage } from "./language";

/** A language this share of a place's searches for the category are written in is measured too. */
export const SECOND_LANGUAGE_MIN_SHARE = 0.1;

export type SecondLanguage =
  | { kind: "none" }
  | { kind: "second"; language: MeasurementLanguage; share: number };

/** Where the shares came from: Google searches, or AI-search volume when Google has none. */
export type LanguageMixSource = "google_ads" | "ai_search";

/** Why a mix holds the main language alone without having been measured. */
export type LanguageMixDegraded = "deadline" | "unavailable" | "spend_cap";

/** How a place's searches for a category split by the language they are written in. */
export interface LanguageMix {
  /** Shares of the languages with searches, adding up to 1; empty when nothing was measured. */
  shares: LanguageShares;
  /** The location the volumes are for: the place, else its region, else its country. */
  level: GeoLevel | null;
  source: LanguageMixSource | null;
  /** The day the volumes were fetched, YYYY-MM-DD. */
  asOf: string | null;
  second: SecondLanguage;
  degraded: LanguageMixDegraded | null;
}

const ORDER = MeasurementLanguage.options;

/** The language other than `main` with the largest share, when it reaches the threshold. */
export function secondLanguageOf(
  shares: LanguageShares,
  main: MeasurementLanguage,
): SecondLanguage {
  let best: SecondLanguage = { kind: "none" };
  for (const language of ORDER) {
    const share = shares[language] ?? 0;
    if (language === main || share < SECOND_LANGUAGE_MIN_SHARE) continue;
    if (best.kind === "none" || share > best.share) best = { kind: "second", language, share };
  }
  return best;
}

/** The main language alone, for a mix that could not be measured in time. */
export const unmeasuredMix = (degraded: LanguageMixDegraded): LanguageMix => ({
  shares: {},
  level: null,
  source: null,
  asOf: null,
  second: { kind: "none" },
  degraded,
});

export type SecondLanguageReason = "owner" | "business_signal" | "search_share";

export interface LanguageDecision {
  main: MeasurementLanguage;
  secondary: {
    language: MeasurementLanguage;
    reasons: SecondLanguageReason[];
    /** Its measured share of searches; null when the mix was not measured. */
    share: number | null;
    /** Whether the headline score weights it in by its share. */
    weighted: boolean;
  } | null;
  /** What `computeFreeReportStats` weights the languages by; set exactly when one is weighted. */
  languageShares: LanguageShares | null;
}

export interface DecideLanguagesInput {
  geo: GeoTarget;
  mix: LanguageMix;
  /** Languages the business's website or listing declares, is written in or says it serves in. */
  businessLanguages: readonly MeasurementLanguage[];
  /** The language the owner says they also serve customers in. */
  alsoServesIn: MeasurementLanguage | null;
}

const positive = (share: number | undefined): share is number =>
  share !== undefined && Number.isFinite(share) && share > 0;

/**
 * The languages a business is measured in: its place's main one (`placeLanguage`), plus at most one more that
 * reaches the search-share threshold, that the business signals or that the owner says they serve
 * in. The owner's word ranks first, then the language with more of the other reasons, then the
 * larger share.
 *
 * A second language chosen from a signal or the owner alone still weighs by its measured share,
 * however small, since that is how the place's customers search. With no measured share (zero, or
 * a mix that could not be measured) it is asked and reported on its own but left out of the
 * headline, which then stands on the main language alone: weighting it by a guess would move the
 * score on no evidence.
 */
export function decideLanguages(input: DecideLanguagesInput): LanguageDecision {
  const main = placeLanguage(input.geo);
  const { shares } = input.mix;
  const signals = new Set(input.businessLanguages);
  let best: { language: MeasurementLanguage; reasons: SecondLanguageReason[] } | null = null;
  let bestKey: number[] = [];
  for (const language of ORDER) {
    if (language === main) continue;
    const share = shares[language] ?? 0;
    const reasons: SecondLanguageReason[] = [];
    if (input.alsoServesIn === language) reasons.push("owner");
    if (signals.has(language)) reasons.push("business_signal");
    if (share >= SECOND_LANGUAGE_MIN_SHARE) reasons.push("search_share");
    if (reasons.length === 0) continue;
    const key = [reasons[0] === "owner" ? 1 : 0, reasons.length, share];
    const wins = key.findIndex((v, i) => v !== bestKey[i]);
    if (best === null || (wins !== -1 && (key[wins] ?? 0) > (bestKey[wins] ?? 0))) {
      best = { language, reasons };
      bestKey = key;
    }
  }
  if (best === null) return { main, secondary: null, languageShares: null };

  const measured = input.mix.degraded === null;
  const share = shares[best.language];
  const mainShare = shares[main];
  const weighted = measured && positive(share) && positive(mainShare);
  return {
    main,
    secondary: { ...best, share: measured ? (share ?? 0) : null, weighted },
    languageShares: weighted ? { [main]: mainShare, [best.language]: share } : null,
  };
}
