import { withSystem } from "@reranker/db";
import { estimates } from "@reranker/db/schema";
import type { FreeReportStats, RateEstimate, ScoreEstimate } from "@reranker/schema/measurement";

export type EstimateRow = typeof estimates.$inferInsert;

const bytes = (hex: string) => Buffer.from(hex, "hex");

/**
 * The rows the free report shows: the target's score overall, per engine, per intent and on the
 * canonical questions, the top competitors' overall score and how often each engine names anyone;
 * and where answers take their sources from: how often they cite the business's sites, the most
 * cited sites overall and per engine, and those only competitors get. Panels read these across
 * reports. Everything else is recomputed from the extractions, byte for byte, when needed.
 */
export function estimateRows(measurementId: string, stats: FreeReportStats): EstimateRow[] {
  const shared = {
    measurementId,
    methodologyHash: bytes(stats.methodologyHash),
    intentSetHash: bytes(stats.intentSetHash),
    extractorConfigHash: bytes(stats.extractorConfigHash),
    seed: bytes(stats.seed),
    computedAt: new Date(stats.computedAt),
  };
  const counts = (rate: RateEstimate) => ({
    successes: rate.successes,
    trials: rate.trials,
    effectiveTrials: rate.effectiveTrials,
    designEffect: rate.designEffect,
  });
  const score = (
    entityKey: string,
    scope: EstimateRow["scope"],
    scopeKey: string | null,
    s: ScoreEstimate,
  ): EstimateRow => ({
    ...shared,
    entityKey,
    scope,
    scopeKey,
    metric: "score",
    estimate: s.value,
    lower: s.lower,
    upper: s.upper,
    ...counts(s.components.recommendationRate),
    level: s.level,
    sufficiency: s.sufficiency,
  });

  const target = stats.target.entityKey;
  const rows: EstimateRow[] = [];
  if (stats.target.overall) rows.push(score(target, "overall", null, stats.target.overall));
  for (const [engine, entry] of Object.entries(stats.target.byEngine)) {
    if (entry) rows.push(score(target, "engine", engine, entry.score));
  }
  for (const intent of stats.intents) {
    rows.push(score(target, "intent", intent.intentId, intent.targetScore));
  }
  if (stats.canonicalOnly) rows.push(score(target, "canonical", null, stats.canonicalOnly.target));
  for (const competitor of stats.competitors) {
    if (competitor.overall) {
      rows.push(score(competitor.entityKey, "overall", null, competitor.overall));
    }
  }
  const rate = (
    entityKey: string,
    scope: EstimateRow["scope"],
    scopeKey: string | null,
    metric: EstimateRow["metric"],
    r: RateEstimate,
  ): EstimateRow => ({
    ...shared,
    entityKey,
    scope,
    scopeKey,
    metric,
    estimate: r.estimate,
    lower: r.lower,
    upper: r.upper,
    ...counts(r),
    level: null,
    sufficiency: null,
  });
  for (const { engine, namesEntitiesRate } of stats.engines) {
    if (namesEntitiesRate) {
      rows.push(rate("*", "engine", engine, "names_entities_rate", namesEntitiesRate));
    }
  }
  const { citations } = stats;
  if (citations.target) {
    rows.push(rate(target, "overall", null, "site_citation_rate", citations.target.rate));
    for (const [engine, r] of Object.entries(citations.target.byEngine)) {
      if (r) rows.push(rate(target, "engine", engine, "site_citation_rate", r));
    }
  }
  for (const d of citations.top) rows.push(rate(d.key, "overall", null, "citation_rate", d.rate));
  for (const [engine, top] of Object.entries(citations.topByEngine)) {
    for (const d of top ?? []) rows.push(rate(d.key, "engine", engine, "citation_rate", d.rate));
  }
  for (const d of citations.competitorOnly) {
    rows.push(rate(d.key, "overall", null, "competitor_citation_rate", d.rate));
  }
  return rows;
}

/**
 * Stores the report's estimates in one statement. Rows never change: a retry inserts nothing and a
 * new methodology version adds its own rows next to the old ones.
 */
export async function persistEstimates(
  measurementId: string,
  stats: FreeReportStats,
): Promise<{ inserted: number }> {
  const rows = estimateRows(measurementId, stats);
  if (rows.length === 0) return { inserted: 0 };
  const result = await withSystem("stats.persist", (tx) =>
    tx.insert(estimates).values(rows).onConflictDoNothing(),
  );
  return { inserted: result.rowCount ?? 0 };
}
