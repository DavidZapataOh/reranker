import { jcs, sha256Hex } from "@reranker/catalog";
import { withSystem } from "@reranker/db";
import { measurementPlans } from "@reranker/db/schema";
import { getArtifact, sealPlan } from "@reranker/evidence";
import type { SpendPurpose } from "@reranker/jobs";
import { InvalidInputError, NotFoundError } from "@reranker/jobs/errors";
import { z } from "@reranker/schema";
import { PlannedSlot } from "@reranker/schema/measurement";
import { eq } from "drizzle-orm";
import { ENGINES } from "./engines";
import { type FrozenSlot, type SlotId, slotId } from "./slot";

// The client whose request shapes the slots are sent with; pinned in the workspace catalog.
const CLIENT = "dataforseo-client@2.1.13";
// measurement_plans.slot_count and captures.slot_index are smallints.
const MAX_SLOTS = 32_767;
const PLAN_CACHE_SIZE = 64;

const Reference = z.object({ refType: z.string().min(1), refId: z.string().min(1) });
const Slots = z.array(PlannedSlot).min(1).max(MAX_SLOTS);
const SealedPlan = z.object({
  version: z.literal(1),
  measurementId: z.string(),
  slots: Slots,
});

export interface LoadedPlan {
  purpose: SpendPurpose;
  refType: string;
  refId: string;
  /** Digest of the plan's signed envelope, which every capture statement of the plan names. */
  planEnvelopeSha256: string;
  slots: FrozenSlot[];
}

function invalid(message: string, error?: z.ZodError): InvalidInputError {
  return new InvalidInputError(error ? `${message}: ${z.prettifyError(error)}` : message);
}

/** Opens a measurement; its plan is frozen later, once its slots are chosen. */
export async function createMeasurement(input: {
  purpose: SpendPurpose;
  refType: string;
  refId: string;
}): Promise<{ measurementId: string }> {
  const reference = Reference.safeParse(input);
  if (!reference.success) throw invalid("Invalid measurement reference", reference.error);
  const [created] = await withSystem("capture", (tx) =>
    tx
      .insert(measurementPlans)
      .values({ purpose: input.purpose, ...reference.data })
      .returning({ id: measurementPlans.id }),
  );
  if (!created) throw new Error("Inserting a measurement returned no row");
  return { measurementId: created.id };
}

function enginesOf(slots: PlannedSlot[]) {
  // Latencies only schedule dispatch; they say nothing about what was asked.
  const used = [...new Set(slots.map((s) => s.engine))];
  return Object.fromEntries(
    used.map((engine) => {
      const { p50LatencyMs: _, ...spec } = ENGINES[engine];
      return [engine, spec];
    }),
  );
}

function slotIdsOf(measurementId: string, count: number): SlotId[] {
  return Array.from({ length: count }, (_, i) => slotId(measurementId, i));
}

/**
 * Seals the plan of a measurement before any of its slots is captured. Freezing the same slots
 * again returns the same plan; other slots are refused, because captures already point at it.
 */
export async function freezeMeasurementPlan(
  measurementId: string,
  slots: PlannedSlot[],
  opts: { meta?: Record<string, unknown> } = {},
): Promise<{ digest: string; slotIds: SlotId[] }> {
  const parsed = Slots.safeParse(slots);
  if (!parsed.success) throw invalid("Invalid plan slots", parsed.error);
  const planBytes = jcs({
    version: 1,
    measurementId,
    slots: parsed.data,
    engines: enginesOf(parsed.data),
    client: CLIENT,
    ...(opts.meta === undefined ? {} : { meta: opts.meta }),
  });
  const digest = sha256Hex(planBytes);
  const slotIds = slotIdsOf(measurementId, parsed.data.length);

  await withSystem("capture", async (tx) => {
    // The row lock makes concurrent freezes of one measurement seal it once.
    const [plan] = await tx
      .select({ digest: measurementPlans.digest, frozenAt: measurementPlans.frozenAt })
      .from(measurementPlans)
      .where(eq(measurementPlans.id, measurementId))
      .for("update");
    if (!plan) throw new NotFoundError(`Measurement ${measurementId} does not exist`);
    if (plan.frozenAt) {
      if (plan.digest?.toString("hex") !== digest) {
        throw new InvalidInputError(`Measurement ${measurementId}: plan already frozen`);
      }
      return;
    }
    const sealed = await sealPlan({ measurementId, planBytes }, { tx });
    await tx
      .update(measurementPlans)
      .set({
        digest: Buffer.from(sealed.planSha256, "hex"),
        planEnvelopeSha256: Buffer.from(sealed.envelopeSha256, "hex"),
        slotCount: parsed.data.length,
        frozenAt: new Date(),
      })
      .where(eq(measurementPlans.id, measurementId));
  });
  return { digest, slotIds };
}

// A frozen plan never changes, so a process keeps the most recent ones it read.
const planCache = new Map<string, LoadedPlan>();

export function resetPlanCache(): void {
  planCache.clear();
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

// Every caller shares the cached object, so a mutation would corrupt every later read.
function remember(measurementId: string, plan: LoadedPlan): void {
  planCache.set(measurementId, deepFreeze(plan));
  if (planCache.size > PLAN_CACHE_SIZE) {
    const oldest = planCache.keys().next().value;
    if (oldest !== undefined) planCache.delete(oldest);
  }
}

/** The frozen plan of a measurement, read from its sealed artifact and checked against its digest. */
export async function loadPlan(measurementId: string): Promise<LoadedPlan> {
  const cached = planCache.get(measurementId);
  if (cached) {
    planCache.delete(measurementId);
    planCache.set(measurementId, cached);
    return cached;
  }
  const [row] = await withSystem("capture", (tx) =>
    tx
      .select({
        purpose: measurementPlans.purpose,
        refType: measurementPlans.refType,
        refId: measurementPlans.refId,
        digest: measurementPlans.digest,
        planEnvelopeSha256: measurementPlans.planEnvelopeSha256,
        frozenAt: measurementPlans.frozenAt,
      })
      .from(measurementPlans)
      .where(eq(measurementPlans.id, measurementId)),
  );
  if (!row) throw new NotFoundError(`Measurement ${measurementId} does not exist`);
  if (!row.frozenAt || !row.digest || !row.planEnvelopeSha256) {
    throw new InvalidInputError(`Measurement ${measurementId} has no frozen plan`);
  }
  const digest = row.digest.toString("hex");
  // getArtifact returns null for bytes that do not hash to the digest.
  const bytes = await getArtifact("plans", digest);
  if (bytes === null) {
    throw new InvalidInputError(`Plan ${digest} of ${measurementId} is missing or altered`);
  }
  const sealed = SealedPlan.safeParse(JSON.parse(new TextDecoder().decode(bytes)));
  if (!sealed.success || sealed.data.measurementId !== measurementId) {
    throw invalid(`Plan ${digest} is not the plan of ${measurementId}`, sealed.error);
  }
  const plan: LoadedPlan = {
    purpose: row.purpose as SpendPurpose,
    refType: row.refType,
    refId: row.refId,
    planEnvelopeSha256: row.planEnvelopeSha256.toString("hex"),
    slots: sealed.data.slots.map((slot, slotIndex) => ({
      ...slot,
      measurementId,
      slotIndex,
      slotId: slotId(measurementId, slotIndex),
    })),
  };
  remember(measurementId, plan);
  return plan;
}
