import { randomUUID } from "node:crypto";
import { type SystemTx, withSystem } from "@reranker/db";
import { captureTaskBatches, captureTasks } from "@reranker/db/schema";
import { assertCaptureAllowed, CaptureChannelDisabledError } from "@reranker/flags";
import {
  acquireProviderSlot,
  InvalidInputError,
  loadJobsConfig,
  ProviderUnavailableError,
  recordIncurredSpend,
  releaseSpend,
  reserveSpend,
  runBatch,
  type SpendContext,
  type SpendReservation,
  settleSpend,
} from "@reranker/jobs";
import { cost, type ProviderCost } from "@reranker/schema";
import { log } from "@reranker/telemetry";
import { and, eq, inArray, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { adapterFor, type CaptureRecord, type PostedTask } from "./adapters";
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
type Failure = { slotId: SlotId; code: string };

const system = <T>(fn: (tx: SystemTx) => Promise<T>) => withSystem("capture.tasks", fn);
const textArray = (values: readonly string[]) => sql`${sql.param(values)}::text[]`;

const taskPrice = (engine: FrozenSlot["engine"]): ProviderCost | undefined =>
  ENGINES[engine].estimate.task;

/** A posting's shared reservation, rebuilt from one of its rows; settling needs only its id. */
function reservationOf(row: TaskRow, tasks: number): SpendReservation | null {
  const spend = row.spend as SpendContext | null;
  const price = taskPrice(row.engine as FrozenSlot["engine"]);
  if (row.reservationId === null || spend === null || !price) return null;
  return {
    id: row.reservationId,
    reserved: cost(price.amount_micros * tasks, price.currency),
    provider: row.provider as SpendReservation["provider"],
    purpose: spend.purpose,
    scopes: [],
  };
}

const sumOf = (costs: readonly ProviderCost[], currency: ProviderCost["currency"]) =>
  cost(
    costs.reduce((sum, c) => sum + c.amount_micros, 0),
    currency,
  );

/** Claims every slot in one statement; a live claim, a posting or an uncollected task holds. */
async function claimAll(slots: readonly FrozenSlot[], token: string): Promise<Set<string>> {
  if (slots.length === 0) return new Set();
  const claimed = await system((tx) =>
    tx
      .insert(captureTasks)
      .values(
        slots.map((slot) => ({
          slotId: slot.slotId,
          measurementId: slot.measurementId,
          provider: slot.provider,
          engine: slot.engine,
          claimToken: token,
        })),
      )
      .onConflictDoUpdate({
        target: captureTasks.slotId,
        set: {
          claimToken: token,
          claimedAt: sql`now()`,
          postingAt: null,
          reservationId: null,
          spend: null,
          vendorTaskId: null,
          postedAt: null,
          fetchingAt: null,
          collectedAt: null,
          batchId: null,
        },
        // A collected task whose slot still lacks a success was an error: a new attempt is new work.
        setWhere: sql`(${captureTasks.postingAt} is null and ${captureTasks.claimedAt} < ${CLAIM_STALE}) or ${captureTasks.collectedAt} is not null`,
      })
      .returning({ slotId: captureTasks.slotId }),
  );
  return new Set(claimed.map((row) => row.slotId));
}

const ownClaims = (slots: readonly FrozenSlot[], token: string) =>
  and(
    inArray(
      captureTasks.slotId,
      slots.map((slot) => slot.slotId),
    ),
    eq(captureTasks.claimToken, token),
  );

/** Posts one task_post call of claimed slots of one engine; the outcome of each slot. */
async function postBatch(
  slots: readonly FrozenSlot[],
  token: string,
  spend: SpendContext,
): Promise<Array<{ slot: FrozenSlot; error: Error | null }>> {
  const [first] = slots as [FrozenSlot];
  const { provider, channel, postTasks } = adapterFor(first.provider);
  const { engine } = first;
  const price = taskPrice(engine);
  if (!postTasks || !price) throw new InvalidInputError(`${engine} cannot be queued`);
  const lease = await acquireProviderSlot(provider, loadJobsConfig().limits[provider]);
  try {
    let reservation: SpendReservation;
    try {
      const estimate = cost(price.amount_micros * slots.length, price.currency);
      reservation = await reserveSpend({ ...spend, provider, channel, engine, estimate });
    } catch (error) {
      await system((tx) => tx.delete(captureTasks).where(ownClaims(slots, token)));
      throw error;
    }
    // From here on the call may go out: only a lookup at the provider can tell what happened.
    const batchId = randomUUID();
    const sending = await system(async (tx) => {
      const marked = await tx
        .update(captureTasks)
        .set({ postingAt: sql`now()`, reservationId: reservation.id, spend, batchId })
        .where(and(ownClaims(slots, token), isNull(captureTasks.postingAt)))
        .returning({ slotId: captureTasks.slotId });
      const kept = new Set(marked.map((row) => row.slotId));
      // A claim taken over while waiting for the lease is no longer ours to post.
      const batch = slots.filter((slot) => kept.has(slot.slotId));
      if (batch.length > 0) {
        await tx.insert(captureTaskBatches).values({
          id: batchId,
          measurementId: first.measurementId,
          provider,
          engine,
          slotIds: batch.map((slot) => slot.slotId),
        });
      }
      return batch;
    });
    if (sending.length === 0) {
      await releaseSpend(reservation);
      return [];
    }

    let tasks: PostedTask[];
    try {
      ({ tasks } = await postTasks(sending));
    } catch (error) {
      // Unknown whether the tasks exist: the posting stays open with its reservation until the
      // lookup settles it. Anything else threw before the call went out.
      if (!(error instanceof ProviderUnavailableError)) {
        await system(async (tx) => {
          await tx.delete(captureTasks).where(ownClaims(sending, token));
          await releaseSpend(reservation, { tx });
        });
      }
      throw error;
    }
    const accepted = tasks.filter((t) => t.status === "accepted");
    const refused = tasks.filter((t) => t.status === "refused");
    const known = [...accepted, ...refused];
    await system(async (tx) => {
      if (accepted.length > 0) {
        await tx.execute(sql`
          update ops.capture_tasks t set vendor_task_id = v.task_id, posted_at = now()
            from unnest(${textArray(accepted.map((t) => t.slot.slotId))},
                        ${textArray(accepted.map((t) => t.providerTaskId as string))}) v (slot_id, task_id)
           where t.slot_id = v.slot_id and t.claim_token = ${token}`);
      }
      // Refused tasks do not exist, so their slots may be posted again.
      if (refused.length > 0) {
        await tx.delete(captureTasks).where(
          ownClaims(
            refused.map((t) => t.slot),
            token,
          ),
        );
      }
      // Settled with what is known now; a task left unknown is charged when the lookup finds it.
      const costs = known.map(
        (t) => t.cost ?? (t.status === "accepted" ? price : cost(0, price.currency)),
      );
      if (known.length > 0) await settle(reservation, sumOf(costs, price.currency), tx);
    });
    return tasks.map((t) => ({
      slot: t.slot,
      error:
        t.status === "accepted"
          ? null
          : t.status === "refused"
            ? (t.error ?? new ProviderUnavailableError(provider, 5000))
            : new ProviderUnavailableError(provider, 5000),
    }));
  } finally {
    await lease.release();
  }
}

/**
 * Settles postings whose answer never arrived, by looking the tasks up at the provider by tag.
 * Every posting of one task_post call shares a reservation, so they are settled together: tasks
 * found are adopted and charged once, tasks the provider never created free their slots.
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
  const bySlotId = new Map<string, FrozenSlot>(plan.slots.map((slot) => [slot.slotId, slot]));
  for (const [provider, own] of Map.groupBy(rows, (row) => row.provider)) {
    const { findTasks, channel } = adapterFor(provider as FrozenSlot["provider"]);
    if (!findTasks) continue;
    const slots = own.flatMap((row) => bySlotId.get(row.slotId) ?? []);
    const times = own.map((row) => (row.postingAt as Date).getTime());
    const found = await findTasks(slots, {
      from: new Date(Math.min(...times) - LOOKUP_MARGIN_MS),
      to: new Date(Math.max(...times) + LOOKUP_SPAN_MS),
    });
    const foundBySlot = new Map<string, (typeof found)[number]>(
      found.map((task) => [task.slot.slotId, task]),
    );
    for (const [reservationId, group] of Map.groupBy(own, (row) => row.reservationId)) {
      await system(async (tx) => {
        // Locked and read again: another process may have settled this posting meanwhile.
        const openRows = await tx
          .select()
          .from(captureTasks)
          .where(
            and(
              inArray(
                captureTasks.slotId,
                group.map((row) => row.slotId),
              ),
              isNull(captureTasks.vendorTaskId),
              isNotNull(captureTasks.postingAt),
              reservationId === null
                ? isNull(captureTasks.reservationId)
                : eq(captureTasks.reservationId, reservationId),
            ),
          )
          .for("update");
        if (openRows.length === 0) return;
        const adopted = openRows.flatMap((row) => {
          const task = foundBySlot.get(row.slotId);
          return task ? [{ row, task }] : [];
        });
        const missing = openRows.filter((row) => !foundBySlot.has(row.slotId));
        for (const row of missing) {
          log.warn("capture.task_posting_not_found", { provider, slot_id: row.slotId });
        }
        if (missing.length > 0) {
          await tx.delete(captureTasks).where(
            inArray(
              captureTasks.slotId,
              missing.map((row) => row.slotId),
            ),
          );
        }
        for (const { row, task } of adopted) {
          log.warn("capture.task_posting_recovered", {
            provider,
            slot_id: row.slotId,
            vendor_task_id: task.providerTaskId,
          });
        }
        if (adopted.length > 0) {
          await tx.execute(sql`
            update ops.capture_tasks t set vendor_task_id = v.task_id, posted_at = t.posting_at
              from unnest(${textArray(adopted.map((a) => a.row.slotId))},
                          ${textArray(adopted.map((a) => a.task.providerTaskId))}) v (slot_id, task_id)
             where t.slot_id = v.slot_id`);
        }
        const [sample] = openRows as [TaskRow];
        const reservation = reservationOf(sample, openRows.length);
        if (!reservation) return;
        if (adopted.length === 0) {
          await releaseSpend(reservation, { tx });
          return;
        }
        const price = taskPrice(sample.engine as FrozenSlot["engine"]) as ProviderCost;
        const amount = sumOf(
          adopted.map((a) => a.task.cost ?? price),
          price.currency,
        );
        const { applied } = await settleSpend(reservation, amount, { tx });
        if (applied) return;
        // The reservation was settled for the tasks whose answer arrived, or released as
        // abandoned by the stale sweep. The provider charged for these regardless, so the charge
        // is recorded where no cap can refuse it.
        await recordIncurredSpend(
          {
            ...(sample.spend as SpendContext),
            provider: reservation.provider,
            channel,
            engine: sample.engine as FrozenSlot["engine"],
          },
          amount,
          { tx },
        );
      });
    }
  }
}

/** Slots of one engine in calls of at most `max` tasks. */
function batchesOf(slots: readonly FrozenSlot[]): FrozenSlot[][] {
  const batches: FrozenSlot[][] = [];
  for (const own of Map.groupBy(slots, (slot) => `${slot.provider}/${slot.engine}`).values()) {
    const [first] = own as [FrozenSlot];
    const max = adapterFor(first.provider).maxTasksPerPost ?? 1;
    for (let i = 0; i < own.length; i += max) batches.push(own.slice(i, i + max));
  }
  return batches;
}

/**
 * Queues the given slots of a frozen plan on the providers' Standard queues, in calls of up to the
 * provider's batch size. Every slot is claimed in `ops.capture_tasks` before its call, so
 * concurrent callers, retries and restarts post it once; a slot with a stored success or a task
 * of its own is skipped.
 */
export async function postCaptureTasks(
  measurementId: string,
  slotIds: SlotId[],
  opts: { spend: SpendContext },
): Promise<{ posted: number; failed: Failure[] }> {
  const slots = await planSlots(measurementId, slotIds);
  await reconcile(measurementId);
  const done = await succeededSlots(measurementId);
  const open = slots.filter((slot) => !done.has(slot.slotIndex));
  const failed: Failure[] = [];
  const queueable = open.filter((slot) => {
    const { postTasks } = adapterFor(slot.provider);
    if (postTasks && taskPrice(slot.engine)) return true;
    failed.push({ slotId: slot.slotId, code: "InvalidInput" });
    return false;
  });
  const allowed = await allowedRoutes(queueable);
  const switchedOn = queueable.filter((slot) => {
    if (allowed.has(routeOf(slot))) return true;
    failed.push({ slotId: slot.slotId, code: "CaptureChannelDisabled" });
    return false;
  });
  const token = randomUUID();
  const claimed = await claimAll(switchedOn, token);
  const batches = batchesOf(switchedOn.filter((slot) => claimed.has(slot.slotId)));
  const results = await runBatch(batches, (batch) => postBatch(batch, token, opts.spend), {
    key: (batch) => (batch[0] as FrozenSlot).slotId,
    isDone: async () => null,
    concurrency: admittedConcurrency(batches.map((batch) => batch[0] as FrozenSlot)),
  });
  let posted = 0;
  results.forEach((result, i) => {
    if (!result.ok) {
      const code = codeOf(result.error);
      for (const slot of batches[i] ?? []) failed.push({ slotId: slot.slotId, code });
      return;
    }
    for (const { slot, error } of result.value) {
      if (error === null) posted += 1;
      else failed.push({ slotId: slot.slotId, code: codeOf(error) });
    }
  });
  return { posted, failed };
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

type Due = { slot: FrozenSlot; row: TaskRow; batch: readonly FrozenSlot[] };

/** Fetches a task by id and stores it; true when it stored the slot's success. */
async function collectOne({ slot, row, batch }: Due): Promise<boolean> {
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
    record = await collectTask(slot, row.vendorTaskId, batch);
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

/** The slots of the call that posted each task, in the order sent, from one read. */
async function withBatches(
  due: ReadonlyArray<{ slot: FrozenSlot; row: TaskRow }>,
  bySlotId: ReadonlyMap<string, FrozenSlot>,
): Promise<Due[]> {
  const ids = [...new Set(due.flatMap((o) => (o.row.batchId ? [o.row.batchId] : [])))];
  const batches =
    ids.length === 0
      ? []
      : await system((tx) =>
          tx
            .select({ id: captureTaskBatches.id, slotIds: captureTaskBatches.slotIds })
            .from(captureTaskBatches)
            .where(inArray(captureTaskBatches.id, ids)),
        );
  const slotsOf = new Map(
    batches.map((b) => [b.id, b.slotIds.flatMap((id) => bySlotId.get(id) ?? [])]),
  );
  // Postings from before batches were recorded carried one task each.
  return due.map((o) => ({
    ...o,
    batch: (o.row.batchId && slotsOf.get(o.row.batchId)) || [o.slot],
  }));
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
  const todo = await withBatches(due.slice(0, opts.max ?? due.length), bySlotId);
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
