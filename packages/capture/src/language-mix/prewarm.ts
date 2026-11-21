import { categoryTerms, getGeo, seedCategories } from "@reranker/catalog";
import type { GeoKey, GeoTarget } from "@reranker/schema/measurement";
import { estimateLanguageMix } from "./estimate";
import { FETCH_MAX_MS } from "./fetch";

// The founder's priority cities. Free reports carry no traffic yet to rank cities by; once they
// do, the busiest cities join this list.
const PRIORITY_CITIES: readonly GeoKey[] = [
  "co-c1003659", // Bogotá
  "co-c1003654", // Medellín
  "co-c1003668", // Cali
  "co-c9048059", // Barranquilla
  "co-c9226733", // Cartagena
  "mx-c1010043", // Ciudad de México
  "es-c1005493", // Madrid
  "us-c1015116", // Miami
];

export interface PrewarmPair {
  geo: GeoTarget;
  categoryKey: string;
}

/** Every local seed category in every priority city; a national one in each of their countries. */
export function prewarmPairs(): PrewarmPair[] {
  const cities = PRIORITY_CITIES.map(getGeo);
  const countries = [...new Set(cities.map((c) => c.country.toLowerCase()))].map(getGeo);
  return seedCategories().flatMap((category) =>
    (category.defaultScope === "local" ? cities : countries).map((geo) => ({
      geo,
      categoryKey: category.key,
    })),
  );
}

export interface PrewarmResult {
  measured: number;
  degraded: number;
  /** Pairs left for the next run because the time budget ran out or the spend cap was hit. */
  left: number;
}

/**
 * Makes sure each pair has a mix younger than 30 days, one pair at a time, so a free report there
 * never waits on DataForSEO. A fresh pair costs a database read; a stale one a fetch, charged to
 * the language-mix purpose and its daily cap. Stops at `budgetMs` or at the cap; claims make a
 * run that overlaps a report's fetch, or another run, pay once.
 */
export async function prewarmLanguageMixes(
  budgetMs: number,
  pairs: readonly PrewarmPair[] = prewarmPairs(),
): Promise<PrewarmResult> {
  const startedAt = Date.now();
  const result: PrewarmResult = { measured: 0, degraded: 0, left: 0 };
  const byKey = new Map(seedCategories().map((c) => [c.key as string, c]));
  const endsAt = startedAt + budgetMs;
  for (const [i, { geo, categoryKey }] of pairs.entries()) {
    const category = byKey.get(categoryKey);
    if (!category) continue;
    if (Date.now() >= endsAt) {
      result.left = pairs.length - i;
      break;
    }
    // A fetch cut by the budget goes on under its claim; the next run finds its row.
    const mix = await estimateLanguageMix({
      geo,
      categoryKey,
      terms: categoryTerms(category),
      deadlineAt: Math.min(endsAt, Date.now() + FETCH_MAX_MS),
    });
    if (mix.degraded === null) {
      result.measured++;
      continue;
    }
    result.degraded++;
    if (mix.degraded === "spend_cap" || mix.degraded === "deadline") {
      result.left = pairs.length - i - 1;
      break;
    }
  }
  return result;
}
