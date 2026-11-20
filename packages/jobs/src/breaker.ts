import { isCheckoutTimeout, withSystem } from "@reranker/db";
import { sql } from "drizzle-orm";
import { loadJobsConfig } from "./config";
import type { PaidProvider } from "./providers";
import { breakerChecked, emit, report } from "./telemetry";

export type BreakerState = "closed" | "open" | "half_open";

type CheckRow = { state: BreakerState; retry_after_ms: number; opened_at: Date | string | null };
type RecordRow = { state: BreakerState; previous: BreakerState };

const asDate = (value: Date | string | null) =>
  value === null || value instanceof Date ? value : new Date(value);

/**
 * Whether calls to the provider may go out. `half_open` goes to a single caller fleet-wide: that
 * caller is the probe and reports its outcome with `breakerRecord`. The probe is held for
 * `probeMs`, which must outlast the call it makes; one that never reports back is handed out
 * again after that, one open window by default.
 */
export async function breakerCheck(
  provider: PaidProvider,
  account = "default",
  probeMs = loadJobsConfig().breaker.openMs,
): Promise<{ state: BreakerState; retryAfterMs: number }> {
  const { rows } = await withSystem("jobs.breaker", (tx) =>
    tx.execute<CheckRow>(
      sql`select * from ops.breaker_check(${provider}, ${account}, ${probeMs}::int)`,
    ),
  );
  const row = rows[0];
  if (!row) throw new Error("breaker_check returned no row");
  await breakerChecked(provider, account, row.state, asDate(row.opened_at));
  return { state: row.state, retryAfterMs: row.retry_after_ms };
}

type Outcomes = {
  successes: number;
  failures: number;
  recorded: Array<() => void>;
  queuedAt: number;
};
type Recorder = { waiting: Outcomes | null; running: boolean };

// One per breaker on this instance: outcomes that arrive while a record is in flight go together
// in the next one, so a burst of calls takes one connection at a time instead of one each.
const recorders = new Map<string, Recorder>();

// A burst that keeps the pool full past its checkout timeout is when a provider outage costs the
// most, so those outcomes wait for a connection instead of being lost. Callers wait with them,
// holding their provider lease, which bounds the wait well below a report's deadline.
const MAX_WAIT_MS = 10_000;

/** False when the checkout timed out: nothing reached the database and the batch can run again. */
async function recordOutcomes(
  provider: PaidProvider,
  account: string,
  outcomes: Outcomes,
): Promise<boolean> {
  try {
    const { minCalls, failureRatio, openMs } = loadJobsConfig().breaker;
    const { rows } = await withSystem("jobs.breaker", (tx) =>
      tx.execute<RecordRow>(
        sql`select * from ops.breaker_record_outcomes(${provider}, ${account}, ${outcomes.successes}::int, ${outcomes.failures}::int, ${minCalls}::int, ${failureRatio}::float8, ${openMs}::int)`,
      ),
    );
    const row = rows[0];
    if (!row) throw new Error("breaker_record_outcomes returned no row");
    if (row.state !== row.previous) {
      emit({ name: "jobs.breaker.state", props: { provider, state: row.state } });
    }
  } catch (error) {
    if (isCheckoutTimeout(error) && performance.now() - outcomes.queuedAt < MAX_WAIT_MS) {
      return false;
    }
    report(`breaker record (${provider})`, error);
  }
  return true;
}

async function drain(provider: PaidProvider, account: string, recorder: Recorder) {
  recorder.running = true;
  while (recorder.waiting) {
    const outcomes = recorder.waiting;
    recorder.waiting = null;
    if (!(await recordOutcomes(provider, account, outcomes))) {
      // Outcomes that arrived meanwhile join the retry, which keeps the oldest caller's deadline.
      const later = recorder.waiting as Outcomes | null;
      recorder.waiting = later
        ? {
            successes: outcomes.successes + later.successes,
            failures: outcomes.failures + later.failures,
            recorded: [...outcomes.recorded, ...later.recorded],
            queuedAt: outcomes.queuedAt,
          }
        : outcomes;
      continue;
    }
    for (const recorded of outcomes.recorded) recorded();
  }
  recorder.running = false;
}

/**
 * Counts one outcome. The adapter decides which provider errors count as failures. Resolves once
 * the outcome is stored, alone when nothing else is being recorded for the breaker, else with the
 * others that arrived meanwhile. It never throws: callers record right after a paid call, and a
 * lost count must not turn a call the provider billed into a failure that releases its spend. A
 * full pool is waited out for up to MAX_WAIT_MS; any other failure is logged. Missed outcomes only
 * delay the breaker, and a probe that never reports is handed out again after its window.
 */
export function breakerRecord(
  provider: PaidProvider,
  outcome: "success" | "failure",
  account = "default",
): Promise<void> {
  const key = `${provider}\u0000${account}`;
  let recorder = recorders.get(key);
  if (!recorder) {
    recorder = { waiting: null, running: false };
    recorders.set(key, recorder);
  }
  recorder.waiting ??= { successes: 0, failures: 0, recorded: [], queuedAt: performance.now() };
  const outcomes = recorder.waiting;
  if (outcome === "failure") outcomes.failures += 1;
  else outcomes.successes += 1;
  const recorded = new Promise<void>((resolve) => outcomes.recorded.push(resolve));
  if (!recorder.running) void drain(provider, account, recorder);
  return recorded;
}
