import { performance } from "node:perf_hooks";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import type {
  EntityStats,
  FreeReportStats,
  RateEstimate,
  ScoreEstimate,
} from "@reranker/schema/measurement";
import { captureServerEvent } from "@reranker/telemetry";
import { wilsonDivergence } from "./interval";
import { methodology } from "./methodology";
import { computeFreeReportStats, type FreeReportInput } from "./report";

const tracer = trace.getTracer("@reranker/stats");

const rateOf = (score: ScoreEstimate | null | undefined) => score?.components.recommendationRate;

function entityRates(entity: EntityStats): (RateEstimate | null | undefined)[] {
  return [rateOf(entity.overall), ...Object.values(entity.byEngine).map((e) => rateOf(e?.score))];
}

/** Every Jeffreys interval the report carries, for checking each one against Wilson. */
function publishedRates(stats: FreeReportStats): RateEstimate[] {
  return [
    ...entityRates(stats.target),
    ...stats.competitors.flatMap(entityRates),
    ...stats.platforms.map((p) => p.recommendedShare),
    ...stats.engines.map((e) => e.namesEntitiesRate),
    ...stats.intents.flatMap((i) => [i.namesEntitiesRate, rateOf(i.targetScore)]),
    rateOf(stats.canonicalOnly?.target),
    ...(stats.canonicalOnly?.competitors ?? []).map((c) => rateOf(c.score)),
  ].filter((rate): rate is RateEstimate => rate != null);
}

/**
 * The free report's statistics step: the pure computation inside a `stats.compute` span, then one
 * `stats_computed` event with its duration, the target's level and how many intervals Wilson
 * disputes. `computeFreeReportStats` stays free of side effects so it can be replayed byte for byte.
 */
export function runFreeReportStats(input: FreeReportInput): FreeReportStats {
  return tracer.startActiveSpan(
    "stats.compute",
    { attributes: { methodology_hash: methodology.hash } },
    (span) => {
      try {
        const start = performance.now();
        const stats = computeFreeReportStats(input);
        const computeMs = Math.round(performance.now() - start);
        const target = stats.target.overall;
        captureServerEvent(
          {
            name: "stats_computed",
            props: {
              methodology_hash: stats.methodologyHash,
              compute_ms: computeMs,
              target_level: target?.level ?? null,
              target_sufficiency: target?.sufficiency ?? null,
              wilson_divergences: publishedRates(stats).filter(
                (rate) => wilsonDivergence(rate) > methodology.wilsonDivergencePts,
              ).length,
              engines_included: stats.engines.filter((e) => e.included).length,
            },
          },
          { subject: { report: input.reportId } },
        );
        return stats;
      } catch (error) {
        // computeFreeReportStats only throws AppError.
        span.recordException(error as Error);
        span.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error).message });
        throw error;
      } finally {
        span.end();
      }
    },
  );
}
