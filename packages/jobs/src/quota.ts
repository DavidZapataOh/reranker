import { withSystem } from "@reranker/db";
import { sql } from "drizzle-orm";
import { loadJobsConfig } from "./config";
import { nextResetAt, spendDay } from "./day";
import { InvalidInputError, QuotaExceededError } from "./errors";
import type { JobPriority } from "./providers";

const PRIORITIES: readonly JobPriority[] = ["critical", "high", "normal", "low"];
const MAX_AMOUNT = 2 ** 31 - 1;

function allocation(name: string): Record<JobPriority, number> {
  const quotas: Record<string, { split: Record<JobPriority, number> }> = loadJobsConfig().quotas;
  // hasOwn keeps names such as `toString` from resolving to the prototype.
  const quota = Object.hasOwn(quotas, name) ? quotas[name] : undefined;
  if (!quota) throw new InvalidInputError(`Unknown quota ${name}`);
  return quota.split;
}

/**
 * Takes `amount` from the daily allocation of one priority class. Classes never borrow from each
 * other, so a flood in one class cannot starve another.
 */
export async function consumeQuota(
  name: string,
  { priority, amount = 1 }: { priority: JobPriority; amount?: number },
): Promise<void> {
  const split = allocation(name);
  if (!PRIORITIES.includes(priority)) throw new InvalidInputError(`Unknown priority ${priority}`);
  if (!Number.isInteger(amount) || amount < 1 || amount > MAX_AMOUNT) {
    throw new InvalidInputError("Quota amount must be a positive whole number");
  }
  // The day and its reset come from one instant, so a call at midnight cannot mix two days.
  const now = new Date();
  const { rows } = await withSystem("jobs.quota", (tx) =>
    tx.execute<{ ok: boolean }>(
      sql`select ops.consume_quota(${spendDay(now)}::date, ${name}::text, ${priority}::text, ${amount}::int, ${split[priority]}::int) as ok`,
    ),
  );
  if (rows[0]?.ok !== true) throw new QuotaExceededError(name, priority, nextResetAt(now));
}

/** What each class of a quota has used today against its allocation. */
export async function quotaStatus(
  name: string,
): Promise<Record<JobPriority, { used: number; limit: number }>> {
  const split = allocation(name);
  const { rows } = await withSystem("jobs.quota", (tx) =>
    tx.execute<{ priority: JobPriority; used: number }>(
      sql`select priority, used from ops.quota_counters
           where day = ${spendDay()}::date and name = ${name}::text`,
    ),
  );
  const used = new Map(rows.map((row) => [row.priority, Number(row.used)]));
  return Object.fromEntries(
    PRIORITIES.map((priority) => [
      priority,
      { used: used.get(priority) ?? 0, limit: split[priority] },
    ]),
  ) as Record<JobPriority, { used: number; limit: number }>;
}
