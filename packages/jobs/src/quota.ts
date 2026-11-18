import { withSystem } from "@reranker/db";
import { type SQL, sql } from "drizzle-orm";
import { loadJobsConfig } from "./config";
import { spendDay } from "./day";
import { InvalidInputError, QuotaExceededError } from "./errors";
import type { JobPriority } from "./providers";

const PRIORITIES: readonly JobPriority[] = ["critical", "high", "normal", "low"];
const MAX_AMOUNT = 2 ** 31 - 1;
const HOUR_MS = 3_600_000;
const WEEK_MS = 7 * 24 * HOUR_MS;

// Classes only order who goes first as an hour fills, in tenths of its limit: low stops early,
// critical and high never before the limit.
const TENTHS: Record<JobPriority, number> = { critical: 10, high: 10, normal: 8, low: 1 };

// One counter row per hour holds every class, so each class limit bounds the hour's total. The
// row's priority only satisfies the counters' key.
const ROW_PRIORITY: JobPriority = "critical";

function brake(name: string): { hourlyFloor: number; peakMultiplier: number } {
  const quotas: Record<string, { hourlyFloor: number; peakMultiplier: number }> =
    loadJobsConfig().quotas;
  // hasOwn keeps names such as `toString` from resolving to the prototype.
  const quota = Object.hasOwn(quotas, name) ? quotas[name] : undefined;
  if (!quota) throw new InvalidInputError(`Unknown quota ${name}`);
  return quota;
}

// UTC hours: Bogota's offset is whole hours, so they start when local hours do.
const hourKey = (name: string, at: number) => `${name}@${new Date(at).toISOString().slice(0, 13)}`;

/**
 * The hour's counter and its limit, `max(floor, multiplier × busiest hour of the last week)`. The
 * current hour is left out of the peak, so a flood can never raise its own limit.
 */
function hour(name: string, now: Date): { day: string; key: string; limit: SQL } {
  const { hourlyFloor, peakMultiplier } = brake(name);
  const key = hourKey(name, now.getTime());
  const weekAgo = now.getTime() - WEEK_MS;
  const peak = sql`(select coalesce(max(used), 0) from ops.quota_counters
                     where day between ${spendDay(new Date(weekAgo - HOUR_MS * 24))}::date
                                   and ${spendDay(now)}::date
                       and name >= ${hourKey(name, weekAgo)}::text and name < ${key}::text)`;
  const limit = sql`least(greatest(${hourlyFloor}::bigint, ${peakMultiplier}::bigint * ${peak}), ${MAX_AMOUNT}::bigint)`;
  return { day: spendDay(now), key, limit };
}

/**
 * Takes `amount` from the current hour of a flood brake. Each class may fill the hour up to its
 * share of the limit, so a burst of low-priority mail can never hold back a sign-in code, and a
 * refusal only lasts until the next hour.
 */
export async function consumeQuota(
  name: string,
  { priority, amount = 1 }: { priority: JobPriority; amount?: number },
): Promise<void> {
  if (!PRIORITIES.includes(priority)) throw new InvalidInputError(`Unknown priority ${priority}`);
  if (!Number.isInteger(amount) || amount < 1 || amount > MAX_AMOUNT) {
    throw new InvalidInputError("Quota amount must be a positive whole number");
  }
  // The hour and its reset come from one instant, so a call on the hour cannot mix two hours.
  const now = new Date();
  const { day, key, limit } = hour(name, now);
  const { rows } = await withSystem("jobs.quota", (tx) =>
    tx.execute<{ ok: boolean }>(
      sql`select ops.consume_quota(${day}::date, ${key}::text, ${ROW_PRIORITY}::text, ${amount}::int,
                 (${limit} * ${TENTHS[priority]}::bigint / 10)::int) as ok`,
    ),
  );
  if (rows[0]?.ok !== true) {
    const nextHour = new Date(Math.floor(now.getTime() / HOUR_MS) * HOUR_MS + HOUR_MS);
    throw new QuotaExceededError(name, priority, nextHour);
  }
}

/** What the current hour of a quota has used against each class's limit. */
export async function quotaStatus(
  name: string,
): Promise<Record<JobPriority, { used: number; limit: number }>> {
  const { day, key, limit } = hour(name, new Date());
  const { rows } = await withSystem("jobs.quota", (tx) =>
    tx.execute<{ used: number; hour_limit: number }>(
      sql`select (select coalesce(sum(used), 0) from ops.quota_counters
                   where day = ${day}::date and name = ${key}::text)::int as used,
                 ${limit}::int as hour_limit`,
    ),
  );
  const used = Number(rows[0]?.used ?? 0);
  const hourLimit = Number(rows[0]?.hour_limit ?? 0);
  return Object.fromEntries(
    PRIORITIES.map((p) => [p, { used, limit: Math.floor((hourLimit * TENTHS[p]) / 10) }]),
  ) as Record<JobPriority, { used: number; limit: number }>;
}
