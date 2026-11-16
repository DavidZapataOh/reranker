import { withSystem } from "@reranker/db";
import { sql } from "drizzle-orm";
import { loadJobsConfig } from "./config";
import type { PaidProvider } from "./providers";

export type BreakerState = "closed" | "open" | "half_open";

type CheckRow = { state: BreakerState; retry_after_ms: number };

/**
 * Whether calls to the provider may go out. `half_open` goes to a single caller fleet-wide: that
 * caller is the probe and reports its outcome with `breakerRecord`.
 */
export async function breakerCheck(
  provider: PaidProvider,
  account = "default",
): Promise<{ state: BreakerState; retryAfterMs: number }> {
  // A probe that never reports back is handed out again after one open window.
  const { openMs } = loadJobsConfig().breaker;
  const { rows } = await withSystem("jobs.breaker", (tx) =>
    tx.execute<CheckRow>(
      sql`select * from ops.breaker_check(${provider}, ${account}, ${openMs}::int)`,
    ),
  );
  const row = rows[0];
  if (!row) throw new Error("breaker_check returned no row");
  return { state: row.state, retryAfterMs: row.retry_after_ms };
}

/** Counts one outcome. The adapter decides which provider errors count as failures. */
export async function breakerRecord(
  provider: PaidProvider,
  outcome: "success" | "failure",
  account = "default",
): Promise<void> {
  const { minCalls, failureRatio, openMs } = loadJobsConfig().breaker;
  await withSystem("jobs.breaker", (tx) =>
    tx.execute(
      sql`select ops.breaker_record(${provider}, ${account}, ${outcome === "failure"}, ${minCalls}::int, ${failureRatio}::float8, ${openMs}::int)`,
    ),
  );
}
