import { withSystem } from "@reranker/db";
import { workflowStarts } from "@reranker/db/schema";
import { and, eq, lt, sql } from "drizzle-orm";

// A claim older than this belongs to a caller that died before recording the run.
const CLAIM_TTL_SECONDS = 30;
const POLL_INTERVAL_MS = 50;
const POLL_TIMEOUT_MS = 5000;

export type StartOnceResult = { runId: string | null; created: boolean };

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const claimOf = (kind: string, key: string) =>
  and(eq(workflowStarts.kind, kind), eq(workflowStarts.key, key));

/**
 * Starts the run for (kind, key) at most once across concurrent callers and retries. The claim is
 * committed before `start` runs, so a slow start never holds a transaction open; a start that
 * throws leaves the claim pending and a later caller takes it over once it is stale.
 */
export async function startOnce(
  kind: string,
  key: string,
  start: () => Promise<{ runId: string }>,
): Promise<StartOnceResult> {
  const claimed = await withSystem("jobs.start-once", async (tx) => {
    const inserted = await tx
      .insert(workflowStarts)
      .values({ kind, key })
      .onConflictDoNothing()
      .returning({ key: workflowStarts.key });
    return inserted.length > 0;
  });
  if (claimed) return runClaimed(kind, key, start);

  const deadline = Date.now() + POLL_TIMEOUT_MS;
  for (;;) {
    const outcome = await withSystem("jobs.start-once", async (tx) => {
      const [row] = await tx
        .select({ status: workflowStarts.status, runId: workflowStarts.runId })
        .from(workflowStarts)
        .where(claimOf(kind, key));
      if (row?.status === "started") return { runId: row.runId };
      const reclaimed = await tx
        .update(workflowStarts)
        .set({ createdAt: sql`now()` })
        .where(
          and(
            claimOf(kind, key),
            eq(workflowStarts.status, "pending"),
            lt(workflowStarts.createdAt, sql`now() - make_interval(secs => ${CLAIM_TTL_SECONDS})`),
          ),
        )
        .returning({ key: workflowStarts.key });
      return reclaimed.length > 0 ? ("reclaimed" as const) : { runId: null };
    });
    if (outcome === "reclaimed") return runClaimed(kind, key, start);
    if (outcome.runId !== null) return { runId: outcome.runId, created: false };
    if (Date.now() >= deadline) return { runId: null, created: false };
    await delay(POLL_INTERVAL_MS);
  }
}

async function runClaimed(
  kind: string,
  key: string,
  start: () => Promise<{ runId: string }>,
): Promise<StartOnceResult> {
  const { runId } = await start();
  await withSystem("jobs.start-once", (tx) =>
    tx.update(workflowStarts).set({ runId, status: "started" }).where(claimOf(kind, key)),
  );
  return { runId, created: true };
}
