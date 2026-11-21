import { widerGeos } from "@reranker/catalog";
import {
  acquireProviderSlot,
  breakerRecord,
  loadJobsConfig,
  type ProviderLimits,
  releaseSpend,
  reserveSpend,
  settleSpend,
} from "@reranker/jobs";
import { cost, costFromMajor, type ProviderCost } from "@reranker/schema";
import type { GeoLevel, GeoTarget, MeasurementLanguage } from "@reranker/schema/measurement";
import {
  AiOptimizationAiKeywordDataKeywordsSearchVolumeLiveRequestInfo,
  KeywordsDataGoogleAdsSearchVolumeLiveRequestInfo,
} from "dataforseo-client";
import { createDataForSeo } from "../dataforseo/client";
import { RawSink } from "../raw/raw-sink";
import { type KeywordVolume, type LanguageKeyword, languageVolumes } from "./keywords";

// Below this many monthly searches a share is noise, so the next wider location is asked.
const MIN_SEARCHES = 100;
// Google Ads Live answers in up to 7 s on average (https://dataforseo.com/pricing/keywords-data/google-ads).
export const CALL_TIMEOUT_MS = 20_000;
/** At most three Google Ads levels and the AI-search fallback, one after another. */
export const FETCH_MAX_MS = 4 * CALL_TIMEOUT_MS;
// DataForSEO allows 12 Google Ads Live requests a minute per account
// (https://docs.dataforseo.com/v3/keywords_data-google_ads-search_volume-live/), apart from the
// SERP and AI endpoints, so they share a pool of their own.
const ADS_LIMITS: ProviderLimits = { maxInFlight: 12, rpm: 12, account: "google-ads-live" };
// DataForSEO list prices (https://dataforseo.com/pricing, read 2026-11-20): Google Ads search
// volume Live US$0.09 per task, AI keyword volume US$0.01 plus US$0.0001 per keyword.
const PRICE = {
  ads: cost(90_000, "USD"),
  aiVolume: (n: number) => cost(10_000 + 100 * n, "USD"),
};
const OK = 20000;

/** The monthly searches per language at the narrowest location that has enough of them. */
export interface LanguageVolumes {
  level: GeoLevel;
  locationCode: number;
  /** Null when no language had searches anywhere. */
  source: "google_ads" | "ai_search" | null;
  volumes: Partial<Record<MeasurementLanguage, number>>;
  /** Every keyword's monthly searches as reported, including those credited to no language. */
  keywordVolumes: Record<string, number>;
  costMicros: number;
}

/** What to ask (`languageKeywords`) and the main language close variants are credited to. */
export interface LanguageQuery {
  keywords: ReadonlyMap<string, LanguageKeyword>;
  main: MeasurementLanguage;
}

export interface FetchContext {
  /** The spend ledger's reference for every call of one fetch. */
  refId: string;
  /** DataForSEO's base; by default the app environment's. Recordings from CI pass production. */
  base?: "production" | "sandbox" | undefined;
}

/** A call that returned nothing usable or an error status; the mix is not stored. */
export class LanguageVolumesError extends Error {}

type Task = {
  status_code?: number | undefined;
  cost?: number | undefined;
  result?: unknown[] | null | undefined;
};

/** One admitted, reserved call; the task comes back with what it was charged. */
async function paidCall(
  { refId, base }: FetchContext,
  estimate: ProviderCost,
  limits: ProviderLimits,
  run: (c: ReturnType<typeof createDataForSeo>) => Promise<{ tasks?: Task[] | undefined } | null>,
): Promise<Task & { charged: number }> {
  const lease = await acquireProviderSlot("dataforseo", limits, { maxWaitMs: CALL_TIMEOUT_MS });
  try {
    const reservation = await reserveSpend({
      provider: "dataforseo",
      purpose: "language-mix",
      refType: "language-mix",
      refId,
      estimate,
    });
    let task: Task | undefined;
    try {
      const clients = createDataForSeo(new RawSink(), {
        timeoutMs: CALL_TIMEOUT_MS,
        ...(base && { base }),
      });
      task = (await run(clients))?.tasks?.[0];
    } catch (error) {
      // Nothing usable came back, yet the request may have been billed.
      await settleSpend(reservation, reservation.reserved);
      await breakerRecord("dataforseo", "failure", limits.account);
      throw new LanguageVolumesError("DataForSEO call failed", { cause: error });
    }
    await breakerRecord("dataforseo", "success", limits.account);
    // A call that reported no cost may still have been billed, so its reservation stands.
    const charged =
      typeof task?.cost === "number" ? costFromMajor(task.cost.toFixed(6), "USD") : null;
    if (charged === null) await settleSpend(reservation, reservation.reserved);
    else if (charged.amount_micros === 0) await releaseSpend(reservation);
    else await settleSpend(reservation, charged);
    return { ...task, charged: (charged ?? reservation.reserved).amount_micros };
  } finally {
    await lease.release();
  }
}

const total = (volumes: LanguageVolumes["volumes"]) =>
  Object.values(volumes).reduce((sum, v) => sum + v, 0);

/**
 * Asks Google Ads for the monthly searches of each language's keywords (`languageKeywords`) at
 * the place, then at its region and its country while it has fewer than 100. Only where Google
 * has none anywhere does AI-search volume, modeled and national, stand in. Throws
 * `LanguageVolumesError` on a failed call, and the spend and admission errors of the jobs runtime.
 */
export async function fetchLanguageVolumes(
  geo: GeoTarget,
  { keywords, main }: LanguageQuery,
  context: FetchContext,
): Promise<LanguageVolumes> {
  const list = [...keywords.keys()];
  const measured = (rows: readonly KeywordVolume[]) => ({
    volumes: languageVolumes(keywords, rows, main),
    keywordVolumes: Object.fromEntries(
      rows.flatMap(({ keyword, volume }) => (keyword && volume ? [[keyword, volume]] : [])),
    ),
  });
  let spent = 0;
  let widest: LanguageVolumes | null = null;
  const seen = new Set<number>();
  for (const target of [geo, ...widerGeos(geo)]) {
    const { locationCode, level } = target.dataforseo;
    if (seen.has(locationCode)) continue;
    seen.add(locationCode);
    const task = await paidCall(context, PRICE.ads, ADS_LIMITS, (c) =>
      c.keywords.googleAdsSearchVolumeLive([
        new KeywordsDataGoogleAdsSearchVolumeLiveRequestInfo({
          keywords: list,
          location_code: locationCode,
        }),
      ]),
    );
    spent += task.charged;
    if (task.status_code !== OK) {
      throw new LanguageVolumesError(`Google Ads answered ${task.status_code}`);
    }
    const rows = ((task.result ?? []) as { keyword?: string; search_volume?: number }[]).map(
      (r): KeywordVolume => ({ keyword: r.keyword ?? null, volume: r.search_volume ?? null }),
    );
    widest = { level, locationCode, source: "google_ads", ...measured(rows), costMicros: spent };
    if (total(widest.volumes) >= MIN_SEARCHES) return widest;
  }
  if (widest && total(widest.volumes) > 0) return widest;

  const country = widerGeos(geo).at(-1) ?? geo;
  const tasks = await Promise.all(
    [...new Set([...keywords.values()].map((k) => k.language))].map((language) => {
      const own = list.filter((k) => keywords.get(k)?.language === language);
      return paidCall(
        context,
        PRICE.aiVolume(own.length),
        loadJobsConfig().limits.dataforseo,
        (c) =>
          c.ai.aiKeywordDataKeywordsSearchVolumeLive([
            new AiOptimizationAiKeywordDataKeywordsSearchVolumeLiveRequestInfo({
              keywords: own,
              location_code: country.dataforseo.locationCode,
              language_code: language,
            }),
          ]),
      );
    }),
  );
  const rows: KeywordVolume[] = [];
  for (const task of tasks) {
    spent += task.charged;
    // A language the location has no AI data for is answered with an error status: no searches.
    if (task.status_code !== OK) continue;
    const items = (
      task.result?.[0] as { items?: { keyword?: string; ai_search_volume?: number }[] } | undefined
    )?.items;
    for (const item of items ?? []) {
      rows.push({ keyword: item.keyword ?? null, volume: item.ai_search_volume ?? null });
    }
  }
  const result = measured(rows);
  return {
    level: "country",
    locationCode: country.dataforseo.locationCode,
    source: total(result.volumes) > 0 ? "ai_search" : null,
    ...result,
    costMicros: spent,
  };
}
