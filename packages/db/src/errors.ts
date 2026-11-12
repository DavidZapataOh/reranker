import { AppError, isAppError } from "@reranker/schema";
import { emitDbEvent } from "./events.ts";

export type DbErrorContext = { pool: "app" | "system"; reason?: string };

const CONNECTION_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EPIPE"]);
// pg-pool's message when no client frees up within connectionTimeoutMillis.
const POOL_TIMEOUT = /timeout exceeded when trying to connect/i;
const CONNECTION_LOST = /Connection terminated (unexpectedly|due to connection timeout)/i;

const hasCode = (value: unknown): value is Error & { code: string } =>
  value instanceof Error && typeof (value as { code?: unknown }).code === "string";

// Drizzle wraps driver errors in DrizzleQueryError (whose message carries the query parameters), so the
// error worth keeping is the innermost one with a code.
export function findCodedError(error: unknown): (Error & { code: string }) | undefined {
  let current: unknown = error;
  for (let depth = 0; current !== undefined && current !== null && depth < 5; depth++) {
    if (hasCode(current)) return current;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

function findPoolTimeout(error: unknown): Error | undefined {
  let current: unknown = error;
  for (let depth = 0; current instanceof Error && depth < 5; depth++) {
    if (POOL_TIMEOUT.test(current.message) || CONNECTION_LOST.test(current.message)) return current;
    current = current.cause;
  }
  return undefined;
}

export function pgErrorCode(error: unknown): string | undefined {
  return findCodedError(error)?.code;
}

export function toDbError(error: unknown, ctx: DbErrorContext): unknown {
  if (isAppError(error)) return error;
  const coded = findCodedError(error);
  const event = (name: Parameters<typeof emitDbEvent>[0]["name"], pgCode?: string) =>
    emitDbEvent({
      name,
      pool: ctx.pool,
      ...(pgCode === undefined ? {} : { pgCode }),
      ...(ctx.reason === undefined ? {} : { reason: ctx.reason }),
    });

  if (coded === undefined || CONNECTION_CODES.has(coded.code)) {
    const unreachable = coded ?? findPoolTimeout(error);
    if (unreachable === undefined) return error;
    if (POOL_TIMEOUT.test(unreachable.message)) event("db_pool_exhausted");
    return new AppError("service_unavailable", { retryAfterSeconds: 2, cause: unreachable });
  }

  switch (coded.code) {
    case "57014":
      return new AppError("timeout", { cause: coded });
    case "23505":
      return new AppError("conflict", { cause: coded });
    case "42501":
      event("db_rls_violation", coded.code);
      return new AppError("internal", { detail: "row level security violation", cause: coded });
    case "53300":
    case "57P03":
      event("db_compute_unavailable", coded.code);
      return new AppError("service_unavailable", { retryAfterSeconds: 30, cause: coded });
    default:
      // Only SQLSTATE codes (five characters) are database errors; anything else is not ours to translate.
      if (!/^[0-9A-Z]{5}$/.test(coded.code)) return error;
      return new AppError("internal", { detail: `database error ${coded.code}`, cause: coded });
  }
}
