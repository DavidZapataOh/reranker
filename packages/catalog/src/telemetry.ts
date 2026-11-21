import { recordVelocities } from "@reranker/jobs/velocity";
import { cost } from "@reranker/schema";
import type { GeoLevel, IntentSet, MeasurementLanguage } from "@reranker/schema/measurement";
import { captureServerEvent, log, runAfter, sendOpsAlert } from "@reranker/telemetry";
import type { FallbackReason } from "./generate/pipeline";

export type IntentSetOutcome = "seed" | "reused" | "generated" | "template";
/** `shared`: a concurrent caller held the generation and fell back, so its template was taken. */
export type TemplateReason = FallbackReason | "shared";

/** How one call to `resolveIntentSet` got its set. */
export interface IntentSetResolution {
  set: IntentSet;
  outcome: IntentSetOutcome;
  language: MeasurementLanguage;
  geoLevel: GeoLevel;
  /** Why a template was served; null for any other outcome. */
  fallback: TemplateReason | null;
  /** Zero unless this call ran the generation itself. */
  generationMs: number;
  costMicros: number;
  generators: 0 | 1 | 2;
  guardRejects: number;
  judgeRejects: number;
}

type Window = { count10m: number; flagged10m: number };

const KEY = "catalog:template-rate";
const NO_SPEND = cost(0, "USD");
// A switched-off generator and a language without reviewed prompts serve templates by design;
// counting them would alert on a decision, not a regression.
const EXPECTED: ReadonlySet<TemplateReason> = new Set(["disabled", "no_prompts", "shared"]);

const shouldAlert = (w: Window) => w.count10m >= 20 && w.flagged10m / w.count10m > 0.1;

// Only the attempt that crosses the threshold alerts, so an incident raises one alert instead of
// one per template for as long as it lasts.
const crossed = (now: Window | undefined, flagged: boolean): now is Window =>
  now !== undefined &&
  shouldAlert(now) &&
  !shouldAlert({ count10m: now.count10m - 1, flagged10m: now.flagged10m - (flagged ? 1 : 0) });

async function track(language: MeasurementLanguage, flagged: boolean): Promise<void> {
  try {
    // The language's own window shows a regression in one language that the overall one dilutes.
    const [all, own] = await recordVelocities([
      { key: KEY, flagged, spend: NO_SPEND },
      { key: `${KEY}:${language}`, flagged, spend: NO_SPEND },
    ]);
    const [scope, window] = crossed(own, flagged)
      ? [language, own]
      : crossed(all, flagged)
        ? ["all", all]
        : [null, null];
    if (scope === null) return;
    await sendOpsAlert("intent-generation-template-rate", {
      language: scope,
      attempts_10m: window.count10m,
      templates_10m: window.flagged10m,
    });
  } catch (error) {
    log.warn("catalog.velocity_failed", {
      error: error instanceof Error ? error.name : "unknown",
    });
  }
}

/**
 * Emits `intent_set_resolved` and logs the set the measurement will use. Attempts to generate feed
 * the template-rate windows after the response, so seeds and reused sets add no database work.
 * Never throws.
 */
export function recordIntentSetResolution(r: IntentSetResolution): void {
  const { manifest } = r.set;
  captureServerEvent(
    {
      name: "intent_set_resolved",
      props: {
        outcome: r.outcome,
        language: r.language,
        fallback: r.fallback,
        category_key: manifest.categoryKey,
        generation_ms: r.generationMs,
        cost_micros: r.costMicros,
        generators: r.generators,
        guard_rejects: r.guardRejects,
        judge_rejects: r.judgeRejects,
      },
    },
    { subject: { system: true } },
  );
  log.info("catalog.intent_set.resolved", {
    intent_set_id: manifest.id,
    intent_set_kind: manifest.kind,
    geo_level: r.geoLevel,
    language: r.language,
    outcome: r.outcome,
    generation_ms: r.generationMs,
    cost_micros: r.costMicros,
    ...(r.fallback && { fallback: r.fallback }),
  });
  const attempted =
    r.outcome === "generated" ||
    (r.outcome === "template" && r.fallback !== null && !EXPECTED.has(r.fallback));
  if (attempted) runAfter(() => track(r.language, r.outcome === "template"));
}
