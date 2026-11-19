import { withSystem } from "@reranker/db";
import { AppError } from "@reranker/schema";
import { sql } from "drizzle-orm";
import { InvalidInputError } from "./errors";
import { assertOpaqueKey } from "./keys";

export interface BucketLimits {
  capacity: number;
  refillPerSecond: number;
}

const INVALID_PARAMETER = "22023";

/**
 * The daily cleanup deletes buckets untouched for this long, and a missing bucket starts full, so
 * every bucket must refill completely within it.
 */
export const BUCKET_IDLE_SECONDS = 2 * 86_400;

function validate(key: string, limits: BucketLimits): void {
  assertOpaqueKey(key);
  const { capacity, refillPerSecond } = limits;
  if (
    !(
      Number.isFinite(capacity) &&
      capacity > 0 &&
      Number.isFinite(refillPerSecond) &&
      refillPerSecond > 0
    )
  ) {
    throw new InvalidInputError("Bucket capacity and refill must be positive numbers");
  }
  if (capacity / refillPerSecond > BUCKET_IDLE_SECONDS) {
    throw new InvalidInputError("A bucket must refill completely within 2 days");
  }
}

// A parameter the database rejects still reads as invalid input, never as an outage.
async function system<T>(fn: Parameters<typeof withSystem<T>>[1]): Promise<T> {
  try {
    return await withSystem("jobs.rate", fn);
  } catch (error) {
    const cause =
      error instanceof AppError ? (error.cause as { code?: string } | undefined) : undefined;
    if (cause?.code === INVALID_PARAMETER)
      throw new InvalidInputError("Bucket parameters rejected");
    throw error;
  }
}

export interface TokenBucket {
  key: string;
  limits: BucketLimits;
  /** Tokens to take or give back; 1 when omitted. */
  cost?: number;
}

// Drizzle expands a bare array into a list; a param binds it as one array value.
function columns(buckets: readonly TokenBucket[]) {
  return {
    keys: sql.param(buckets.map((b) => b.key)),
    caps: sql.param(buckets.map((b) => b.limits.capacity)),
    refills: sql.param(buckets.map((b) => b.limits.refillPerSecond)),
    costs: sql.param(buckets.map((b) => b.cost ?? 1)),
  };
}

type TakeRow = { ok: boolean; remaining: number[]; retry_after_ms: number };
type PeekRow = { remaining: number; retry_after_ms: number };

/**
 * Takes from every bucket or from none, in one statement on one connection; a denial carries the
 * longest wait among the buckets that are short. `remaining` follows the order of `buckets`.
 */
export async function takeAllTokens(
  buckets: readonly TokenBucket[],
): Promise<{ ok: boolean; remaining: number[]; retryAfterMs: number }> {
  for (const { key, limits, cost = 1 } of buckets) {
    validate(key, limits);
    if (!(Number.isFinite(cost) && cost >= 0 && cost <= limits.capacity)) {
      throw new InvalidInputError("Bucket cost must be between zero and the capacity");
    }
  }
  const { keys, caps, refills, costs } = columns(buckets);
  const { rows } = await system((tx) =>
    tx.execute<TakeRow>(
      sql`select * from ops.take_tokens(${keys}::text[], ${caps}::float8[], ${refills}::float8[], ${costs}::float8[])`,
    ),
  );
  const row = rows[0];
  if (!row) throw new Error("take_tokens returned no row");
  return { ok: row.ok, remaining: row.remaining, retryAfterMs: row.retry_after_ms };
}

/** Takes `cost` tokens (default 1) or none; a denial carries the exact wait until it would pass. */
export async function takeTokens(
  key: string,
  limits: BucketLimits,
  cost = 1,
): Promise<{ ok: boolean; remaining: number; retryAfterMs: number }> {
  const { ok, remaining, retryAfterMs } = await takeAllTokens([{ key, limits, cost }]);
  return { ok, remaining: remaining[0] ?? 0, retryAfterMs };
}

/** Reads the balance without taking anything; the wait is until one token is available. */
export async function peekTokens(
  key: string,
  limits: BucketLimits,
): Promise<{ remaining: number; retryAfterMs: number }> {
  validate(key, limits);
  const { rows } = await system((tx) =>
    tx.execute<PeekRow>(
      sql`select * from ops.peek_tokens(${key}, ${limits.capacity}::float8, ${limits.refillPerSecond}::float8)`,
    ),
  );
  const row = rows[0];
  if (!row) throw new Error("peek_tokens returned no row");
  return { remaining: row.remaining, retryAfterMs: row.retry_after_ms };
}

/**
 * Gives tokens back to every bucket after an admission that did no work, never above a capacity,
 * in one statement on one connection.
 */
export async function refundAllTokens(buckets: readonly TokenBucket[]): Promise<void> {
  for (const { key, limits, cost = 1 } of buckets) {
    validate(key, limits);
    if (!(Number.isFinite(cost) && cost >= 0)) {
      throw new InvalidInputError("Refund must be a non-negative number");
    }
  }
  if (buckets.length === 0) return;
  const { keys, caps, refills, costs } = columns(buckets);
  // Volatile functions in the select list run after ORDER BY, so the rows lock in key order, as
  // take_tokens locks them, and overlapping refunds cannot deadlock.
  await system((tx) =>
    tx.execute(
      sql`select ops.refund_tokens(b.key, b.cap, b.refill, b.cost)
            from unnest(${keys}::text[], ${caps}::float8[], ${refills}::float8[], ${costs}::float8[])
              as b (key, cap, refill, cost)
           order by b.key`,
    ),
  );
}

/** Gives tokens back after an admission that did no work; never above the capacity. */
export async function refundTokens(key: string, limits: BucketLimits, cost = 1): Promise<void> {
  await refundAllTokens([{ key, limits, cost }]);
}
