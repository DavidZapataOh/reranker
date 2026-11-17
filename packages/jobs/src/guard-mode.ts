import { withSystem } from "@reranker/db";
import { AppError } from "@reranker/schema";
import { sql } from "drizzle-orm";
import { InvalidInputError } from "./errors";

const INVALID_PARAMETER = "22023";
const MAX_HOLD_MS = 2 ** 31 - 1;
const NAME = /^[a-z0-9][a-z0-9:._-]{0,99}$/i;

// A parameter the database rejects is invalid input, never an outage.
async function system<T>(fn: Parameters<typeof withSystem<T>>[1]): Promise<T> {
  try {
    return await withSystem("jobs.guard-mode", fn);
  } catch (error) {
    const cause =
      error instanceof AppError ? (error.cause as { code?: string } | undefined) : undefined;
    if (cause?.code === INVALID_PARAMETER) {
      throw new InvalidInputError("Guard mode parameters rejected");
    }
    throw error;
  }
}

function assertName(name: string): void {
  if (!NAME.test(name)) throw new InvalidInputError("Guard mode name must be a short token");
}

const asDate = (value: Date | string) => (value instanceof Date ? value : new Date(value));

/**
 * Turns a guard mode on for `holdMs`, or extends one already on (never shortens it). Only the
 * call that turned it on reports `newlyTripped`, so only one caller announces it.
 */
export async function tripGuardMode(
  name: string,
  reason: string,
  holdMs: number,
): Promise<{ active: true; activeUntil: Date; newlyTripped: boolean }> {
  assertName(name);
  if (!reason.trim()) throw new InvalidInputError("A guard mode needs a reason");
  if (!Number.isInteger(holdMs) || holdMs < 1 || holdMs > MAX_HOLD_MS) {
    throw new InvalidInputError("Guard mode hold must be a positive whole number of milliseconds");
  }
  const { rows } = await system((tx) =>
    tx.execute<{ active_until: Date | string; newly_tripped: boolean }>(
      sql`select * from ops.trip_guard_mode(${name}::text, ${reason}::text, ${holdMs}::int)`,
    ),
  );
  const row = rows[0];
  if (!row) throw new Error("trip_guard_mode returned no row");
  return { active: true, activeUntil: asDate(row.active_until), newlyTripped: row.newly_tripped };
}

/**
 * Reads a guard mode; one that has expired is marked released by the same statement, and only that
 * call sees `releasedNow`, so only one caller announces the release. A name never tripped is off.
 */
export async function guardModeStatus(name: string): Promise<{
  active: boolean;
  activeUntil: Date | null;
  reason: string | null;
  releasedNow: boolean;
}> {
  assertName(name);
  const { rows } = await system((tx) =>
    tx.execute<{
      active: boolean;
      active_until: Date | string | null;
      reason: string | null;
      released_now: boolean;
    }>(sql`select * from ops.guard_mode_status(${name}::text)`),
  );
  const row = rows[0];
  if (!row) throw new Error("guard_mode_status returned no row");
  return {
    active: row.active,
    activeUntil: row.active_until === null ? null : asDate(row.active_until),
    reason: row.reason,
    releasedNow: row.released_now,
  };
}

/** When the guard mode now active was tripped, kept while it is extended; null while it is off. */
export async function guardModeSince(name: string): Promise<Date | null> {
  assertName(name);
  const { rows } = await system((tx) =>
    tx.execute<{ tripped_at: Date | string }>(
      sql`select tripped_at from ops.guard_modes
           where name = ${name} and released_at is null and active_until > clock_timestamp()`,
    ),
  );
  const row = rows[0];
  return row ? asDate(row.tripped_at) : null;
}
