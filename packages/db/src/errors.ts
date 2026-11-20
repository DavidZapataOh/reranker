import { AppError, isAppError } from "@reranker/schema";
import { DrizzleQueryError } from "drizzle-orm";
import pg from "pg";
import { emitDbEvent } from "./events";
import type { SystemReason } from "./tenancy";

type Ctx = { pool: "app" | "system"; reason?: SystemReason };

const NETWORK_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EPIPE"]);
// pg-pool's message when no connection came free, or none could be opened, within the timeout.
const CHECKOUT_TIMEOUT = "timeout exceeded when trying to connect";

function event(name: "db_rls_violation" | "db_compute_unavailable", code: string, ctx: Ctx) {
  emitDbEvent({ name, pool: ctx.pool, pgCode: code, ...(ctx.reason && { reason: ctx.reason }) });
}

// The cause keeps the driver error for logs; the customer-facing problem carries no SQL detail.
function fromPg(err: pg.DatabaseError, ctx: Ctx): AppError {
  const code = err.code ?? "";
  const cause = err;
  switch (code) {
    // 55P03: a lock wait ran past lock_timeout, the caller's own bound on a contended row.
    case "57014":
    case "55P03":
      return new AppError("timeout", { cause });
    case "23505":
      return new AppError("conflict", { cause });
    case "42501":
      event("db_rls_violation", code, ctx);
      return new AppError("internal", { cause });
    // 53000: Neon suspended the compute because the plan ran out of compute hours.
    case "53000":
    case "53300":
    case "57P03":
      event("db_compute_unavailable", code, ctx);
      return new AppError("service_unavailable", { retryAfterSeconds: 30, cause });
    default:
      if (code.startsWith("08") || code === "57P01") {
        return new AppError("service_unavailable", { retryAfterSeconds: 2, cause });
      }
      return new AppError("internal", { cause });
  }
}

export function toDbError(err: unknown, ctx: Ctx): unknown {
  // Drizzle wraps every driver failure and puts the SQL and its parameters in the message.
  if (err instanceof DrizzleQueryError) {
    const translated = toDbError(err.cause, ctx);
    if (translated !== err.cause || isAppError(translated)) return translated;
    return new AppError("internal", { cause: err.cause });
  }
  if (err instanceof pg.DatabaseError) return fromPg(err, ctx);
  if (!(err instanceof Error) || isAppError(err)) return err;
  // pg reports a dropped socket without a code.
  if (err.message.startsWith("Connection terminated")) {
    return new AppError("service_unavailable", { retryAfterSeconds: 2, cause: err });
  }
  if (err.message.startsWith(CHECKOUT_TIMEOUT)) {
    emitDbEvent({
      name: "db_pool_exhausted",
      pool: ctx.pool,
      ...(ctx.reason && { reason: ctx.reason }),
    });
    return new AppError("service_unavailable", { retryAfterSeconds: 2, cause: err });
  }
  const code = (err as { code?: unknown }).code;
  if (typeof code === "string" && NETWORK_CODES.has(code)) {
    return new AppError("service_unavailable", { retryAfterSeconds: 2, cause: err });
  }
  return err;
}

/**
 * Whether a transaction failed waiting for a connection. It never reached the database, so running
 * it again cannot apply it twice.
 */
export function isCheckoutTimeout(error: unknown): boolean {
  return (
    isAppError(error) &&
    error.code === "service_unavailable" &&
    error.cause instanceof Error &&
    error.cause.message.startsWith(CHECKOUT_TIMEOUT)
  );
}
