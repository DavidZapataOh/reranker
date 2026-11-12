import { AppError, isAppError } from "./app-error.ts";
import { type DbPoolKind, emitDbEvent } from "./events.ts";

export type DbErrorContext = { pool: DbPoolKind; reason?: string };

// Messages node-postgres uses when no connection could be obtained in connectionTimeoutMillis.
const CONNECT_TIMEOUT_MESSAGES = [
  "timeout exceeded when trying to connect",
  "Connection terminated due to connection timeout",
];

const CONNECTION_REFUSED = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT"]);

// Drizzle wraps driver errors, so the code can sit anywhere in the cause chain.
function findCode(error: unknown, matches: (code: string) => boolean): string | undefined {
  for (let current = error, depth = 0; current && depth < 5; depth++) {
    if (typeof current !== "object") return undefined;
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && matches(code)) return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

export function pgCodeOf(error: unknown): string | undefined {
  return findCode(error, (code) => /^[0-9A-Z]{5}$/.test(code));
}

function isConnectTimeout(error: unknown): boolean {
  return (
    error instanceof Error && CONNECT_TIMEOUT_MESSAGES.some((text) => error.message.includes(text))
  );
}

// Translates driver and pool failures into application errors; anything else passes through
// untouched so callers keep their own errors.
export function toDbError(error: unknown, ctx: DbErrorContext): unknown {
  if (isAppError(error)) return error;

  if (isConnectTimeout(error)) {
    emitDbEvent({ name: "db_pool_exhausted", pool: ctx.pool, ...reasonOf(ctx) });
    return new AppError("service_unavailable", {
      retryAfterSeconds: 2,
      detail: `no ${ctx.pool} connection available`,
      cause: error,
    });
  }
  if (findCode(error, (code) => CONNECTION_REFUSED.has(code))) {
    return new AppError("service_unavailable", {
      retryAfterSeconds: 2,
      detail: "database unreachable",
      cause: error,
    });
  }

  const pgCode = pgCodeOf(error);
  if (pgCode === undefined) return error;
  switch (pgCode) {
    case "57014":
      return new AppError("timeout", { detail: "statement timeout", cause: error });
    case "23505":
      return new AppError("conflict", { detail: "unique violation", cause: error });
    case "42501":
      emitDbEvent({ name: "db_rls_violation", pool: ctx.pool, pgCode, ...reasonOf(ctx) });
      return new AppError("internal", { detail: "insufficient privilege", cause: error });
    case "53300":
    case "57P03":
      emitDbEvent({ name: "db_compute_unavailable", pool: ctx.pool, pgCode, ...reasonOf(ctx) });
      return new AppError("service_unavailable", {
        retryAfterSeconds: 30,
        detail: "database compute unavailable",
        cause: error,
      });
    default:
      return new AppError("internal", { detail: `database error ${pgCode}`, cause: error });
  }
}

function reasonOf(ctx: DbErrorContext): { reason?: string } {
  return ctx.reason === undefined ? {} : { reason: ctx.reason };
}
