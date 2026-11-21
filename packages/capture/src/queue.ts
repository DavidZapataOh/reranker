import { randomUUID } from "node:crypto";
import { type SystemTx, withSystem } from "@reranker/db";
import { captureTasks } from "@reranker/db/schema";
import { assertCaptureAllowed, CaptureChannelDisabledError } from "@reranker/flags";
import {
  acquireProviderSlot,
  InvalidInputError,
  loadJobsConfig,
  ProviderUnavailableError,
  releaseSpend,
  reserveSpend,
  runBatch,
  type SpendContext,
  type SpendReservation,
  settleSpend,
} from "@reranker/jobs";
import type { ProviderCost } from "@reranker/schema";
import { log } from "@reranker/telemetry";
import { and, eq, inArray, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { adapterFor, type CaptureRecord } from "./adapters";
import {
  admittedConcurrency,
  codeOf,
  outcomeOf,
  planSlots,
  settle,
  succeededSlots,
} from "./capture";
import { ENGINES } from "./engines";
import { loadPlan } from "./measurement";
import { persistCapture } from "./persist";
import { resolveRedirects } from "./resolve-redirects";
import type { FrozenSlot, SlotId } from "./slot";
import { captureCallOf, recordCaptureCall } from "./telemetry";

// A claim that never reached the provider call belongs to a process that died; it is taken over.
const CLAIM_STALE = sql`now() - interval '2 minutes'`;
// A posting is looked up once its call has surely ended (115 s timeout) and the provider's task
// list has caught up.
const LOOKUP_AFTER = sql`now() - interval '5 minutes'`;
const LOOKUP_MARGIN_MS = 60_000;
const LOOKUP_SPAN_MS = 5 * 60_000;
// Standard tasks finish within 45 minutes; one not listed as ready after an hour is fetched by id.
const FETCH_BY_ID_AFTER = sql`now() - interval '60 minutes'`;
// A fetch started this long ago and still not stored failed: it is fetched again by id.
const REFETCH_AFTER = sql`now() - interval '2 minutes'`;

type TaskRow = typeof captureTasks.$inferSelect;

const system = <T>(fn: (tx: SystemTx) => Promise<T>) => withSystem("capture.tasks", fn);

/** The open reservation of a posting, rebuilt from its row; settling needs only its id. */
function reservationOf(row: TaskRow): SpendReservation | null {
  const spend = row.spend as SpendContext | null;
  if (row.reservationId === null || spend === null) return null;
  const estimate = ENGINES[row.engine as FrozenSlot["engine"]].estimate.task;
  return {
    id: row.reservationId,
    reserved: estimate ?? ENGINES[row.engine as FrozenSlot["engine"]].estimate.live,
    provider: row.provider as SpendReservation["provider"],
    purpose: spend.purpose,
    scopes: [],
  };
}

/** Takes the slot's claim unless a live claim, a posting or an uncollected task holds it. */
async function claim(slot: FrozenSlot, token: string): Promise<boolean> {
  const fresh = {
    claimToken: token,
    claimedAt: sql`now()`,
    postingAt: null,
    reservationId: null,
    spend: null,
    vendorTaskId: null,
    postedAt: null,
    fetchingAt: null,
    collectedAt: null,
  };
  const claimed = await system((tx) =>
    tx
      .insert(captureTasks)
      .values({
        slotId: slot.slotId,
        measurementId: slot.measurementId,
        provider: slot.provider,
        engine: slot.engine,
        claimToken: token,
      })
      .onConflictDoUpdate({
        target: captureTasks.slotId,
        set: fresh,
        // A collected task whose slot still lacks a success was an error: a new attempt is new work.
        setWhere: sql`(${captureTasks.postingAt} is null and ${captureTasks.claimedAt} < ${CLAIM_STALE}) or ${captureTasks.collectedAt} is not null`,
      })
      .returning({ slotId: captureTasks.slotId }),
  );
  return claimed.length > 0;
}

const ownClaim = (slot: FrozenSlot, token: string) =>
  and(eq(captureTasks.slotId, slot.slotId), eq(captureTasks.claimToken, token));

async function dropClaim(slot: FrozenSlot, token: string, reservation?: SpendReservation) {
  await system(async (tx) => {
    await tx.delete(captureTasks).where(ownClaim(slot, token));
    if (reservation) await releaseSpend(reservation, { tx });
  });
}

/** Posts one claimed slot; false when another process holds it. */
async function postOne(slot: FrozenSlot, spend: SpendContext): Promise<boolean> {
  const adapter = adapterFor(slot.provider);
  const { provider, channel, postTask } = adapter;
  const { engine } = slot;
  const estimate = ENGINES[engine].estimate.task;
  if (!postTask || !estimate) {
    throw new InvalidInputError(`${engine} cannot be queued through ${provider}`);
  }
  await assertCaptureAllowed({ channel, provider, engine });
  const token = randomUUID();
  if (!(await claim(slot, token))) return false;

  const lease = await acquireProviderSlot(provider, loadJobsConfig().limits[provider]);
  try {
    let reservation: SpendReservation;
    try {
      reservation = await reserveSpend({ ...spend, provider, channel, engine, estimate });
    } catch (error) {
      await dropClaim(slot, token);
      throw error;
    }
    // From here on the call may go out: only a lookup at the provider can tell what happened.
    const posting = await system((tx) =>
      tx
        .update(captureTasks)
        .set({ postingAt: sql`now()`, reservationId: reservation.id, spend })
        .where(and(ownClaim(slot, token), isNull(captureTasks.postingAt)))
        .returning({ slotId: captureTasks.slotId }),
    );
    if (posting.length === 0) {
      await releaseSpend(reservation);
      return false;
    }

    let posted: Awaited<ReturnType<typeof postTask>>;
    try {
      posted = await postTask(slot);
    } catch (error) {
      // Nothing came back: the task may exist and be billed, so the posting stays open with its
      // reservation until the lookup settles it. Anything else threw before the call went out.
      if (!(error instanceof ProviderUnavailableError)) await dropClaim(slot, token, reservation);
      throw error;
    }
    const { providerTaskId, cost, error } = posted;
    // Accepted without an id: the posting stays open for the lookup, which also settles it.
    if (error === null && providerTaskId === null) {
      throw new ProviderUnavailableError(provider, 5000);
    }
    await system(async (tx) => {
      if (error === null) {
        await tx
          .update(captureTasks)
          .set({ vendorTaskId: providerTaskId, postedAt: sql`now()` })
          .where(ownClaim(slot, token));
      } else {
        // Refused: no task exists, so the slot may be posted again.
        await tx.delete(captureTasks).where(ownClaim(slot, token));
      }
      await settle(reservation, cost, tx);
    });
    if (error !== null) throw error;
    return true;
  } finally {
    await lease.release();
  }
}

/**
 * Settles postings whose answer never arrived, by looking the task up at the provider by its tag.
 * A task found is adopted and charged once; a task the provider never created frees the slot.
 */
async function reconcile(measurementId: string): Promise<void> {
  const rows = await system((tx) =>
    tx
      .select()
      .from(captureTasks)
      .where(
        and(
          eq(captureTasks.measurementId, measurementId),
          isNull(captureTasks.vendorTaskId),
          lt(captureTasks.postingAt, LOOKUP_AFTER),
        ),
      ),
  );
  if (rows.length === 0) return;
  const plan = await loadPlan(measurementId);
  for (const [provider, own] of Map.groupBy(rows, (row) => row.provider)) {
    const { findTasks, channel } = adapterFor(provider as FrozenSlot["provider"]);
    if (!findTasks) continue;
    const slots = own.flatMap((row) => plan.slots.filter((s) => s.slotId === row.slotId));
    const times = own.map((row) => (row.postingAt as Date).getTime());
    const found = await findTasks(slots, {
      from: new Date(Math.min(...times) - LOOKUP_MARGIN_MS),
      to: new Date(Math.max(...times) + LOOKUP_SPAN_MS),
    });
    const bySlot = new Map<string, (typeof found)[number]>(
      found.map((task) => [task.slot.slotId, task]),
    );
    for (const row of own) {
      const task = bySlot.get(row.slotId);
      const reservation = reservationOf(row);
      const open = and(
        eq(captureTasks.slotId, row.slotId),
        eq(captureTasks.claimToken, row.claimToken),
        isNull(captureTasks.vendorTaskId),
      );
      if (!task) {
        log.warn("capture.task_posting_not_found", { provider, slot_id: row.slotId });
        await system(async (tx) => {
          const freed = await tx.delete(captureTasks).where(open).returning();
          if (freed.length > 0 && reservation) await releaseSpend(reservation, { tx });
        });
        continue;
      }
      log.warn("capture.task_posting_recovered", {
        provider,
        slot_id: row.slotId,
        vendor_task_id: task.providerTaskId,
      });
      const charged: ProviderCost | null = task.cost;
      const outcome = await system(async (tx) => {
        const adopted = await tx
          .update(captureTasks)
          .set({ vendorTaskId: task.providerTaskId, postedAt: row.postingAt })
          .where(open)
          .returning();
        if (adopted.length === 0 || !reservation) return "skipped" as const;
        const { applied } = await settleSpend(reservation, charged ?? reservation.reserved, { tx });
        return applied ? ("settled" as const) : ("released" as const);
      });
      // The stale-reservation sweep gave the reservation back before the task was found; the
      // charge is recorded anew so the ledger still holds it once.
      if (outcome === "released" && reservation) {
        const spend = row.spend as SpendContext;
        const amount = charged ?? reservation.reserved;
        try {
          const again = await reserveSpend({
            ...spend,
            provider: reservation.provider,
            channel,
            engine: row.engine as FrozenSlot["engine"],
            estimate: amount,
          });
          await settleSpend(again, amount);
        } catch (error) {
          // The task is adopted either way; a charge the caps refuse is left for operations.
          log.error("capture.task_charge_unrecorded", {
            provider,
            slot_id: row.slotId,
            micro_usd: amount.amount_micros,
            error: error instanceof Error ? error.name : "unknown",
          });
        }
      }
    }
  }
}

/**
 * Queues the given slots of a frozen plan on the providers' Standard queues, one task each. Every
 * slot is claimed in `ops.capture_tasks` before its call, so concurrent callers, retries and
 * restarts post it once; a slot with a stored success or a task of its own is skipped.
 */
export async function postCaptureTasks(
  measurementId: string,
  slotIds: SlotId[],
  opts: { spend: SpendContext },
): Promise<{ posted: number; failed: Array<{ slotId: SlotId; code: string }> }> {
  const slots = await planSlots(measurementId, slotIds);
  await reconcile(measurementId);
  const done = await succeededSlots(measurementId);
  const todo = slots.filter((slot) => !done.has(slot.slotIndex));
  const results = await runBatch(todo, (slot) => postOne(slot, opts.spend), {
    key: (slot) => slot.slotId,
    isDone: async () => null,
    concurrency: admittedConcurrency(todo),
  });
  return {
    posted: results.filter((r) => r.ok && r.value).length,
    failed: results.flatMap((r) =>
      r.ok ? [] : [{ slotId: r.key as SlotId, code: codeOf(r.error) }],
    ),
  };
}

const routeOf = (slot: FrozenSlot) => `${slot.provider}/${slot.engine}`;

async function allowedRoutes(slots: readonly FrozenSlot[]): Promise<Set<string>> {
  const allowed = new Set<string>();
  const routes = new Map(slots.map((slot) => [routeOf(slot), slot]));
  await Promise.all(
    [...routes].map(async ([route, { provider, engine }]) => {
      try {
        await assertCaptureAllowed({ channel: adapterFor(provider).channel, provider, engine });
        allowed.add(route);
      } catch (error) {
        if (!(error instanceof CaptureChannelDisabledError)) throw error;
      }
    }),
  );
  return allowed;
}

type Due = { slot: FrozenSlot; row: TaskRow };

/** Fetches a task by id and stores it; true when it stored the slot's success. */
async function collectOne({ slot, row }: Due): Promise<boolean> {
  const adapter = adapterFor(slot.provider);
  const { provider, channel, collectTask } = adapter;
  if (!collectTask || row.vendorTaskId === null) return false;
  const mine = and(
    eq(captureTasks.slotId, slot.slotId),
    eq(captureTasks.claimToken, row.claimToken),
  );
  // Marked first: once fetched the provider stops listing the task, and only this mark tells a
  // later collection to fetch it again by id.
  await system((tx) => tx.update(captureTasks).set({ fetchingAt: sql`now()` }).where(mine));
  const lease = await acquireProviderSlot(provider, loadJobsConfig().limits[provider]);
  let record: CaptureRecord | null;
  try {
    record = await collectTask(slot, row.vendorTaskId);
  } finally {
    await lease.release();
  }
  if (record === null) {
    // Not run yet: it will be listed as ready when it has.
    await system((tx) => tx.update(captureTasks).set({ fetchingAt: null }).where(mine));
    return false;
  }
  try {
    const answer = record.answer && (await resolveRedirects(record.answer));
    const { stored } = await persistCapture(
      { ...record, answer },
      {
        attempt: 1,
        late: false,
        inTransaction: (tx) => tx.update(captureTasks).set({ collectedAt: sql`now()` }).where(mine),
      },
    );
    return stored && record.status === "succeeded";
  } finally {
    const outcome = outcomeOf(record);
    recordCaptureCall(
      captureCallOf(record, {
        channel,
        late: false,
        alert: outcome.ok ? undefined : outcome.alert,
      }),
    );
  }
}

/**
 * Fetches and stores the finished queued tasks of a measurement, at most `max` of them, by the
 * task ids recorded when they were posted. `pending` counts the plan's slots still without a
 * stored success.
 */
export async function collectReadyTasks(
  measurementId: string,
  opts: { max?: number } = {},
): Promise<{ collected: number; pending: number }> {
  await reconcile(measurementId);
  const plan = await loadPlan(measurementId);
  const done = await succeededSlots(measurementId);
  const rows = await system((tx) =>
    tx
      .select({
        row: captureTasks,
        stale: sql<boolean>`${captureTasks.postedAt} < ${FETCH_BY_ID_AFTER} or ${captureTasks.fetchingAt} < ${REFETCH_AFTER}`,
      })
      .from(captureTasks)
      .where(
        and(
          eq(captureTasks.measurementId, measurementId),
          isNotNull(captureTasks.vendorTaskId),
          isNull(captureTasks.collectedAt),
        ),
      ),
  );
  const bySlotId = new Map(plan.slots.map((slot) => [slot.slotId, slot]));
  const unfinished = rows.flatMap(({ row, stale }) => {
    const slot = bySlotId.get(row.slotId as SlotId);
    return slot && !done.has(slot.slotIndex) ? [{ slot, row, stale }] : [];
  });
  // A slot stored by another path needs nothing more from its task.
  const settled = rows.filter(({ row }) => !unfinished.some((o) => o.row.slotId === row.slotId));
  if (settled.length > 0) {
    await system((tx) =>
      tx
        .update(captureTasks)
        .set({ collectedAt: sql`now()` })
        .where(
          inArray(
            captureTasks.slotId,
            settled.map(({ row }) => row.slotId),
          ),
        ),
    );
  }

  // A switched-off engine makes no call at all, not even to list or fetch.
  const allowed = await allowedRoutes(unfinished.map((o) => o.slot));
  const open = unfinished.filter((o) => allowed.has(routeOf(o.slot)));
  const listed = new Set<string>();
  for (const [provider, own] of Map.groupBy(open, (o) => o.slot.provider)) {
    const ready = (await adapterFor(provider).collectReady?.(own.map((o) => o.slot))) ?? [];
    for (const task of ready) listed.add(task.providerTaskId);
  }
  const due = open.filter((o) => o.stale || listed.has(o.row.vendorTaskId ?? ""));
  const todo = due.slice(0, opts.max ?? due.length);
  const results = await runBatch(todo, collectOne, {
    key: (o) => o.slot.slotId,
    isDone: async () => null,
    concurrency: admittedConcurrency(todo.map((o) => o.slot)),
  });
  const failure = results.find((r) => !r.ok);
  // Everything that could be stored is; the rest is fetched again by id on the next collection.
  if (failure && !failure.ok) throw failure.error;
  const succeeded = await succeededSlots(measurementId);
  return {
    collected: results.filter((r) => r.ok && r.value).length,
    pending: plan.slots.length - succeeded.size,
  };
}
