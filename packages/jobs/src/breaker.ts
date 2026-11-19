import { withSystem } from "@reranker/db";
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

type Outcomes = { successes: number; failures: number; recorded: Array<() => void> };
type Recorder = { waiting: Outcomes | null; running: boolean };

// One per breaker on this instance: outcomes that arrive while a record is in flight go together
// in the next one, so a burst of calls takes one connection at a time instead of one each.
const recorders = new Map<string, Recorder>();

async function recordOutcomes(provider: PaidProvider, account: string, outcomes: Outcomes) {
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
    report(`breaker record (${provider})`, error);
  }
}

async function drain(provider: PaidProvider, account: string, recorder: Recorder) {
  recorder.running = true;
  while (recorder.waiting) {
    const outcomes = recorder.waiting;
    recorder.waiting = null;
    await recordOutcomes(provider, account, outcomes);
    for (const recorded of outcomes.recorded) recorded();
  }
  recorder.running = false;
}

/**
 * Counts one outcome. The adapter decides which provider errors count as failures. Resolves once
 * the outcome is stored, alone when nothing else is being recorded for the breaker, else with the
 * others that arrived meanwhile. It never throws: callers record right after a paid call, and a
 * lost count must not turn a call the provider billed into a failure that releases its spend. A
 * failure is logged; missed outcomes only delay the breaker, and a probe that never reports is
 * handed out again after its window.
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
  recorder.waiting ??= { successes: 0, failures: 0, recorded: [] };
  const outcomes = recorder.waiting;
  if (outcome === "failure") outcomes.failures += 1;
  else outcomes.successes += 1;
  const recorded = new Promise<void>((resolve) => outcomes.recorded.push(resolve));
  if (!recorder.running) void drain(provider, account, recorder);
  return recorded;
}
