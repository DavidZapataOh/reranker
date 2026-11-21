import { type CanaryVariant, canarySet, geoForEngine, getGeo } from "@reranker/catalog";
import { withSystem } from "@reranker/db";
import { measurementPlans } from "@reranker/db/schema";
import { InvalidInputError } from "@reranker/jobs/errors";
import type { CaptureProvider, EngineId } from "@reranker/schema";
import type { PlannedSlot } from "@reranker/schema/measurement";
import { and, asc, eq, sql } from "drizzle-orm";
import { freezeMeasurementPlan } from "../measurement";
import { assertPinnedProfile, CONTROL_PROFILE } from "../openai/profile";

export type CanaryLane = "api" | "brightdata" | "dataforseo";

const RUNS = 10;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

// The order slots are numbered in: the API channel, the UI engines Bright Data scrapes in one
// batch, the UI engines on DataForSEO's Standard queue, and one ChatGPT audit run on DataForSEO.
const LANES: ReadonlyArray<{
  lane: CanaryLane;
  provider: CaptureProvider;
  engines: readonly EngineId[];
  runs: number;
}> = [
  { lane: "api", provider: "openai", engines: ["chatgpt"], runs: RUNS },
  { lane: "brightdata", provider: "brightdata", engines: ["chatgpt", "perplexity"], runs: RUNS },
  {
    lane: "dataforseo",
    provider: "dataforseo",
    engines: ["gemini", "google-ai-overview", "google-ai-mode"],
    runs: RUNS,
  },
  { lane: "dataforseo", provider: "dataforseo", engines: ["chatgpt"], runs: 1 },
];

const REFERENCE = { purpose: "control-canary", refType: "control_canary" } as const;

function slotsOf(intentSetId: PlannedSlot["intentSetId"], variants: readonly CanaryVariant[]) {
  return LANES.flatMap(({ provider, engines, runs }) =>
    engines.flatMap((engine) =>
      variants.flatMap((v): PlannedSlot[] => {
        const geoDeclared = geoForEngine(engine, getGeo(v.geoKey), v.scope, { provider });
        if (!geoDeclared) throw new InvalidInputError(`${engine} is not offered in ${v.geoKey}`);
        return Array.from({ length: runs }, (_, runIndex) => ({
          engine,
          provider,
          intentSetId,
          intentId: v.intentId,
          paraphraseId: v.paraphraseId,
          ...(v.personaId === null ? {} : { personaId: v.personaId }),
          geoKey: v.geoKey,
          geoDeclared,
          runIndex,
          promptText: v.prompt,
          language: "es",
          variantId: v.variantId,
          promptSha256: v.promptSha256,
          isCanonical: v.isCanonical,
        }));
      }),
    ),
  );
}

function lanesOf(slots: readonly PlannedSlot[]): Record<CanaryLane, number> {
  const lanes: Record<CanaryLane, number> = { api: 0, brightdata: 0, dataforseo: 0 };
  for (const slot of slots) {
    lanes[slot.provider === "openai" ? "api" : slot.provider] += 1;
  }
  return lanes;
}

/** The day's measurement, created under a lock so concurrent planners of a date share one. */
async function measurementFor(date: string): Promise<string> {
  return withSystem("control-canary", async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`control-canary:${date}`}))`);
    const [existing] = await tx
      .select({ id: measurementPlans.id })
      .from(measurementPlans)
      .where(
        and(
          eq(measurementPlans.purpose, REFERENCE.purpose),
          eq(measurementPlans.refType, REFERENCE.refType),
          eq(measurementPlans.refId, date),
        ),
      )
      .orderBy(asc(measurementPlans.createdAt))
      .limit(1);
    if (existing) return existing.id;
    const [created] = await tx
      .insert(measurementPlans)
      .values({ ...REFERENCE, refId: date })
      .returning({ id: measurementPlans.id });
    if (!created) throw new Error("Inserting the canary measurement returned no row");
    return created.id;
  });
}

/**
 * The daily control canary as one frozen measurement: every canary question ten times per engine
 * and channel, and once more for ChatGPT through DataForSEO. Planning the same date again returns
 * the same measurement and plan.
 */
export async function planCanary(
  date: string,
): Promise<{ measurementId: string; lanes: Record<CanaryLane, number> }> {
  // Date.parse rolls 2026-02-30 over to March, so the date must survive the round trip.
  const parsed = new Date(`${date}T00:00:00Z`);
  if (
    !DAY.test(date) ||
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== date
  ) {
    throw new InvalidInputError(`Invalid canary date ${JSON.stringify(date)}`);
  }
  // A plan carries the control profile it was frozen with, so it may only carry the pinned one.
  assertPinnedProfile();
  const canary = canarySet();
  const slots = slotsOf(canary.intentSetId, canary.variants);
  const measurementId = await measurementFor(date);
  await freezeMeasurementPlan(measurementId, slots, {
    meta: { canary: { id: canary.id, version: canary.version }, controlProfile: CONTROL_PROFILE },
  });
  return { measurementId, lanes: lanesOf(slots) };
}
