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

/**
 * Counts one outcome. The adapter decides which provider errors count as failures. It never
 * throws: callers record right after a paid call, and a lost count must not turn a call the
 * provider billed into a failure that releases its spend. A failure is logged; one missed outcome
 * only delays the breaker, and a probe that never reports is handed out again after its window.
 */
export async function breakerRecord(
  provider: PaidProvider,
  outcome: "success" | "failure",
  account = "default",
): Promise<void> {
  try {
    const { minCalls, failureRatio, openMs } = loadJobsConfig().breaker;
    const { rows } = await withSystem("jobs.breaker", (tx) =>
      tx.execute<RecordRow>(
        sql`select * from ops.breaker_record_transition(${provider}, ${account}, ${outcome === "failure"}, ${minCalls}::int, ${failureRatio}::float8, ${openMs}::int)`,
      ),
    );
    const row = rows[0];
    if (!row) throw new Error("breaker_record_transition returned no row");
    if (row.state !== row.previous) {
      emit({ name: "jobs.breaker.state", props: { provider, state: row.state } });
    }
  } catch (error) {
    report(`breaker record (${provider}, ${outcome})`, error);
  }
}
