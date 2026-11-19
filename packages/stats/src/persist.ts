import { withSystem } from "@reranker/db";
import { estimates } from "@reranker/db/schema";
import type { FreeReportStats, RateEstimate, ScoreEstimate } from "@reranker/schema/measurement";

export type EstimateRow = typeof estimates.$inferInsert;

const bytes = (hex: string) => Buffer.from(hex, "hex");

/**
 * The rows the free report shows: the target's score overall, per engine, per intent and on the
 * canonical questions, the top competitors' overall score and how often each engine names anyone.
 * Everything else is recomputed from the extractions, byte for byte, when needed.
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
  for (const { engine, namesEntitiesRate: rate } of stats.engines) {
    if (!rate) continue;
    rows.push({
      ...shared,
      entityKey: "*",
      scope: "engine",
      scopeKey: engine,
      metric: "names_entities_rate",
      estimate: rate.estimate,
      lower: rate.lower,
      upper: rate.upper,
      ...counts(rate),
      level: null,
      sufficiency: null,
    });
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
