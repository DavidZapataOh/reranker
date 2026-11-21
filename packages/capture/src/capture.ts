import { type SystemTx, withSystem } from "@reranker/db";
import { captures } from "@reranker/db/schema";
import { assertCaptureAllowed } from "@reranker/flags";
import {
  acquireProviderSlot,
  InvalidInputError,
  loadJobsConfig,
  ProviderUnavailableError,
  RateLimitedError,
  releaseSpend,
  reserveSpend,
  runBatch,
  type SpendContext,
  type SpendReservation,
  settleSpend,
} from "@reranker/jobs";
import { isAppError, type ProviderCost } from "@reranker/schema";
import { and, eq } from "drizzle-orm";
import { adapterFor, type CaptureRecord, registerCaptureAdapter } from "./adapters";
import { dataforseoAdapter } from "./dataforseo/adapter";
import { mapDataForSeoStatus } from "./dataforseo/status";
import { dispatchOrder, retryFits } from "./dispatch";
import { ENGINES } from "./engines";
import { loadPlan } from "./measurement";
import { openaiAdapter } from "./openai/adapter";
import { loadIntentSets, persistCapture } from "./persist";
import { resolveRedirects } from "./resolve-redirects";
import { type FrozenSlot, parseSlotId, type SlotId } from "./slot";
import { captureCallOf, recordCaptureCall } from "./telemetry";

registerCaptureAdapter(dataforseoAdapter);
registerCaptureAdapter(openaiAdapter);

export type CaptureSlotsOptions = {
  mode: "live";
  spend: SpendContext;
  /** The report's cut: captures stored after it are late, and no retry starts that cannot end before it. */
  deadlineAt?: number;
  onProgress?: (p: { slotId: SlotId; ok: boolean }) => Promise<void>;
};

type Outcome = { ok: true } | { ok: false; error: Error; retryable: boolean; alert?: "balance" };

const asError = (error: unknown) => (error instanceof Error ? error : new Error(String(error)));
export const codeOf = (error: Error) =>
  isAppError(error) ? error.code : error.name.replace(/Error$/, "");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const isLate = (opts: CaptureSlotsOptions) =>
  opts.deadlineAt !== undefined && Date.now() > opts.deadlineAt;

function bodyOf(bytes: Uint8Array): unknown | null {
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

export function outcomeOf(record: CaptureRecord): Outcome {
  if (record.status === "succeeded") return { ok: true };
  if (record.failure) return { ok: false, ...record.failure };
  const outcome = mapDataForSeoStatus({
    httpStatus: record.httpStatus,
    body: bodyOf(record.response),
    timedOut: record.status === "timeout",
  });
  return outcome.ok ? { ok: true } : outcome;
}

// A call that reported no cost may still have been billed, so its reservation stands.
export function settle(reservation: SpendReservation, charged: ProviderCost | null, tx?: SystemTx) {
  if (charged === null) return settleSpend(reservation, reservation.reserved, { tx });
  if (charged.amount_micros === 0) return releaseSpend(reservation, { tx });
  return settleSpend(reservation, charged, { tx });
}

/** Admission, spend and the call; the reservation comes back open for the caller to settle. */
async function call(
  slot: FrozenSlot,
  opts: CaptureSlotsOptions,
): Promise<{ record: CaptureRecord; reservation: SpendReservation }> {
  const adapter = adapterFor(slot.provider);
  const { provider, channel } = adapter;
  const { engine } = slot;
  await assertCaptureAllowed({ channel, provider, engine });
  // A report waits for capacity until its cut; other work waits the configured inline time.
  const lease = await acquireProviderSlot(
    provider,
    loadJobsConfig().limits[provider],
    opts.deadlineAt === undefined ? {} : { maxWaitMs: Math.max(0, opts.deadlineAt - Date.now()) },
  );
  try {
    const estimate = adapter.estimate?.(slot) ?? ENGINES[engine].estimate.live;
    const reservation = await reserveSpend({ ...opts.spend, provider, channel, engine, estimate });
    const started = performance.now();
    try {
      return { record: await adapter.captureLive(slot), reservation };
    } catch (error) {
      // Nothing came back, yet the request may have reached the provider and been billed.
      if (error instanceof ProviderUnavailableError) {
        recordCaptureCall({
          engine,
          provider,
          channel,
          mode: "live",
          status: "no_response",
          latencyMs: Math.round(performance.now() - started),
          cost: null,
          parseFailed: false,
          surfaceAbsent: false,
          late: isLate(opts),
          providerStatusCode: null,
        });
        await settleSpend(reservation, reservation.reserved);
      } else {
        await releaseSpend(reservation);
      }
      throw error;
    }
  } finally {
    // The lease bounds calls in flight; sealing what came back needs no provider capacity.
    await lease.release();
  }
}

async function captureOne(
  slot: FrozenSlot,
  attempt: number,
  opts: CaptureSlotsOptions,
): Promise<Outcome> {
  let called: Awaited<ReturnType<typeof call>>;
  try {
    called = await call(slot, opts);
  } catch (error) {
    const err = asError(error);
    const retryable = err instanceof RateLimitedError || err instanceof ProviderUnavailableError;
    return { ok: false, error: err, retryable };
  }
  const { record, reservation } = called;
  const outcome = outcomeOf(record);
  let settled = false;
  let late = isLate(opts);
  try {
    // Google wraps the cited sites in its own redirects; attribution needs where they lead.
    const answer = record.answer && (await resolveRedirects(record.answer));
    late = isLate(opts);
    // The cost settles in the row's own transaction: one round trip fewer, and the ledger and
    // the stored capture never disagree.
    ({ transacted: settled } = await persistCapture(
      { ...record, answer },
      { attempt, late, inTransaction: (tx) => settle(reservation, record.cost, tx) },
    ));
  } catch (error) {
    // The provider was paid: calling again in this run would pay twice. The step's own retry
    // finds no stored capture for the slot and captures it then.
    return { ok: false, error: asError(error), retryable: false };
  } finally {
    recordCaptureCall(
      captureCallOf(record, {
        channel: adapterFor(slot.provider).channel,
        late,
        alert: outcome.ok ? undefined : outcome.alert,
      }),
    );
    if (!settled) await settle(reservation, record.cost);
  }
  return outcome;
}

async function captureWithRetry(slot: FrozenSlot, opts: CaptureSlotsOptions): Promise<void> {
  let outcome = await captureOne(slot, 1, opts);
  if (!outcome.ok && outcome.retryable) {
    const { retryAfterMs = 0 } = outcome.error as { retryAfterMs?: number };
    if (retryFits({ slot, retryAfterMs, deadlineAt: opts.deadlineAt, now: Date.now() })) {
      await sleep(retryAfterMs);
      outcome = await captureOne(slot, 2, opts);
    }
  }
  if (!outcome.ok) throw outcome.error;
}

export async function succeededSlots(measurementId: string): Promise<Set<number>> {
  // Served by the partial unique index captures_one_success.
  const rows = await withSystem("capture", (tx) =>
    tx
      .select({ slotIndex: captures.slotIndex })
      .from(captures)
      .where(and(eq(captures.measurementId, measurementId), eq(captures.status, "succeeded"))),
  );
  return new Set(rows.map((row) => row.slotIndex));
}

/** The frozen slots of `slotIds`, every one of which must belong to the measurement's plan. */
export async function planSlots(measurementId: string, slotIds: SlotId[]): Promise<FrozenSlot[]> {
  const plan = await loadPlan(measurementId);
  const slots = slotIds.map((id) => {
    const { measurementId: owner, slotIndex } = parseSlotId(id);
    const slot = plan.slots[slotIndex];
    if (owner !== measurementId || !slot) {
      throw new InvalidInputError(`Slot ${id} is not in the plan of ${measurementId}`);
    }
    return slot;
  });
  // A statement that cannot name its intent set must fail before anything is paid.
  await loadIntentSets(slots.map((slot) => slot.intentSetId));
  return slots;
}

// No more slots run than their providers' lease pools admit: the rest would only wait for a
// lease while holding database connections the running ones need to seal and settle.
export function admittedConcurrency(
  slots: readonly { provider: FrozenSlot["provider"] }[],
): number {
  const { limits } = loadJobsConfig();
  const admitted = [...new Set(slots.map((slot) => slot.provider))].reduce(
    (sum, provider) => sum + limits[provider].maxInFlight,
    0,
  );
  return Math.max(1, Math.min(slots.length, admitted));
}

/**
 * Captures the given slots of a frozen plan, each once: a slot with a stored success is never
 * called again, so a retried step pays only for what is missing. Failures are returned per slot.
 */
export async function captureSlots(
  measurementId: string,
  slotIds: SlotId[],
  opts: CaptureSlotsOptions,
): Promise<{ succeeded: SlotId[]; failed: Array<{ slotId: SlotId; code: string }> }> {
  const slots = await planSlots(measurementId, slotIds);
  const done = await succeededSlots(measurementId);
  const ordered = dispatchOrder(slots);
  const results = await runBatch(
    ordered,
    async (slot) => {
      let ok = false;
      try {
        await captureWithRetry(slot, opts);
        ok = true;
      } finally {
        await opts.onProgress?.({ slotId: slot.slotId, ok });
      }
      return true;
    },
    {
      key: (slot) => slot.slotId,
      isDone: async (key) => (done.has(parseSlotId(key).slotIndex) ? true : null),
      concurrency: admittedConcurrency(ordered),
    },
  );
  return {
    succeeded: results.filter((r) => r.ok).map((r) => r.key as SlotId),
    failed: results.flatMap((r) =>
      r.ok ? [] : [{ slotId: r.key as SlotId, code: codeOf(r.error) }],
    ),
  };
}

/** Captures control slots through the OpenAI API, refusing any slot routed elsewhere. */
export async function captureControl(
  measurementId: string,
  slotIds: SlotId[],
  opts: { spend: SpendContext },
): ReturnType<typeof captureSlots> {
  const plan = await loadPlan(measurementId);
  for (const id of slotIds) {
    const { measurementId: owner, slotIndex } = parseSlotId(id);
    const slot = plan.slots[slotIndex];
    if (owner === measurementId && slot && slot.provider !== "openai") {
      throw new InvalidInputError(`Slot ${id} is routed to ${slot.provider}, not the control API`);
    }
  }
  return captureSlots(measurementId, slotIds, { mode: "live", spend: opts.spend });
}
