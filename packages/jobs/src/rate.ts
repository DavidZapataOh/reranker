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

// Drizzle expands a bare array into a list; a param binds it as one array value.
const one = (value: number | string) => sql.param([value]);

type TakeRow = { ok: boolean; remaining: number[]; retry_after_ms: number };
type PeekRow = { remaining: number; retry_after_ms: number };

/** Takes `cost` tokens (default 1) or none; a denial carries the exact wait until it would pass. */
export async function takeTokens(
  key: string,
  limits: BucketLimits,
  cost = 1,
): Promise<{ ok: boolean; remaining: number; retryAfterMs: number }> {
  validate(key, limits);
  if (!(Number.isFinite(cost) && cost >= 0 && cost <= limits.capacity)) {
    throw new InvalidInputError("Bucket cost must be between zero and the capacity");
  }
  const { rows } = await system((tx) =>
    tx.execute<TakeRow>(
      sql`select * from ops.take_tokens(${one(key)}::text[], ${one(limits.capacity)}::float8[], ${one(limits.refillPerSecond)}::float8[], ${one(cost)}::float8[])`,
    ),
  );
  const row = rows[0];
  if (!row) throw new Error("take_tokens returned no row");
  return { ok: row.ok, remaining: row.remaining[0] ?? 0, retryAfterMs: row.retry_after_ms };
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

/** Gives tokens back after an admission that did no work; never above the capacity. */
export async function refundTokens(key: string, limits: BucketLimits, cost = 1): Promise<void> {
  validate(key, limits);
  if (!(Number.isFinite(cost) && cost >= 0)) {
    throw new InvalidInputError("Refund must be a non-negative number");
  }
  await system((tx) =>
    tx.execute(
      sql`select ops.refund_tokens(${key}, ${limits.capacity}::float8, ${limits.refillPerSecond}::float8, ${cost}::float8)`,
    ),
  );
}
