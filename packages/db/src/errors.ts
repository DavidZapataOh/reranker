import { AppError } from "@reranker/schema";
import pg from "pg";
import { emitDbEvent } from "./events";

export type SystemReason = string;

type Ctx = { pool: "app" | "system"; reason?: SystemReason };

const NETWORK_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EPIPE"]);

function event(name: "db_rls_violation" | "db_compute_unavailable", code: string, ctx: Ctx) {
  emitDbEvent({ name, pool: ctx.pool, pgCode: code, ...(ctx.reason && { reason: ctx.reason }) });
}

// The cause keeps the driver error for logs; the customer-facing problem carries no SQL detail.
function fromPg(err: pg.DatabaseError, ctx: Ctx): AppError {
  const code = err.code ?? "";
  const cause = err;
  switch (code) {
    case "57014":
      return new AppError("timeout", { cause });
    case "23505":
      return new AppError("conflict", { cause });
    case "42501":
      event("db_rls_violation", code, ctx);
      return new AppError("internal", { cause });
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
  if (err instanceof pg.DatabaseError) return fromPg(err, ctx);
  if (!(err instanceof Error) || (err as { name?: string }).name === "AppError") return err;
  if (err.message.startsWith("timeout exceeded when trying to connect")) {
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
