import { withSystem } from "@reranker/db";
import { invitations, rateLimits, sessions, verifications } from "@reranker/db/schema/auth";
import { inArray, lt, type SQL } from "drizzle-orm";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

const SESSION_RETENTION_MS = 30 * DAY_MS;
const VERIFICATION_RETENTION_MS = DAY_MS;
const RATE_LIMIT_RETENTION_MS = DAY_MS;
const INVITATION_RETENTION_MS = 90 * DAY_MS;

// Small enough that one delete stays far below the statement timeout and its locks are brief.
const BATCH_SIZE = 5000;

type PurgedTable = typeof sessions | typeof verifications | typeof rateLimits | typeof invitations;

// Each batch commits on its own, so a run cut short keeps its progress and the next one resumes.
// Rows Better Auth holds at that moment are skipped rather than waited on; a later run gets them.
async function deleteInBatches(table: PurgedTable, expired: SQL, batchSize: number) {
  let deleted = 0;
  for (;;) {
    const { rowCount } = await withSystem("auth.purge", (tx) =>
      tx
        .delete(table)
        .where(
          inArray(
            table.id,
            tx
              .select({ id: table.id })
              .from(table)
              .where(expired)
              .limit(batchSize)
              .for("update", { skipLocked: true }),
          ),
        ),
    );
    deleted += rowCount ?? 0;
    if ((rowCount ?? 0) < batchSize) return deleted;
  }
}

/**
 * Deletes auth rows nobody can use any more. Better Auth only prunes verifications and rate-limit
 * rows as a side effect of later requests, and never prunes sessions or invitations. Cutoffs use
 * the app's clock, which is the one that wrote these timestamps.
 */
export async function purgeExpiredAuthRecords({ batchSize = BATCH_SIZE } = {}): Promise<{
  sessions: number;
  verifications: number;
  rateLimits: number;
}> {
  const now = Date.now();
  const before = (ms: number) => new Date(now - ms);
  const result = {
    sessions: await deleteInBatches(
      sessions,
      lt(sessions.expiresAt, before(SESSION_RETENTION_MS)),
      batchSize,
    ),
    verifications: await deleteInBatches(
      verifications,
      lt(verifications.expiresAt, before(VERIFICATION_RETENTION_MS)),
      batchSize,
    ),
    rateLimits: await deleteInBatches(
      rateLimits,
      lt(rateLimits.lastRequest, now - RATE_LIMIT_RETENTION_MS),
      batchSize,
    ),
  };
  // An invitation closes when it is answered or canceled, which happens before it expires, or
  // when it expires: past that point plus the retention, every invitation is closed for long enough.
  await deleteInBatches(
    invitations,
    lt(invitations.expiresAt, before(INVITATION_RETENTION_MS)),
    batchSize,
  );
  return result;
}
