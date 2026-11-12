import { AppError, isAppError } from "@reranker/schema";
import { DrizzleQueryError } from "drizzle-orm/errors";
import { DatabaseError } from "pg";
import { type DbPool, emitDbEvent } from "./events.ts";

export type DbErrorContext = { pool: DbPool; reason?: string };

// pg-pool's message when every client stays checked out past connectionTimeoutMillis.
const POOL_WAIT_TIMEOUT = "timeout exceeded when trying to connect";
const CONNECTION_LOST = [
  "Connection terminated due to connection timeout",
  "Connection terminated unexpectedly",
  "Client has encountered a connection error and is not queryable",
];
const NETWORK_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EPIPE"]);

// Seconds before a retry can succeed: a freed pool slot comes fast, a resumed compute does not.
const RETRY_POOL_SECONDS = 2;
const RETRY_COMPUTE_SECONDS = 30;

/**
 * Turns pg and pool failures into AppError. Anything else, an AppError included, is returned as is.
 * The query text and its parameters never reach the result: only the pg code goes in the detail.
 */
export function toDbError(error: unknown, ctx: DbErrorContext): unknown {
  if (isAppError(error)) return error;
  const pg = findDatabaseError(error);
  if (pg !== undefined) return fromDatabaseError(pg, ctx);

  const root = rootCause(error);
  if (!(root instanceof Error)) return error;
  if (root.message === POOL_WAIT_TIMEOUT) {
    emitDbEvent({ name: "db_pool_exhausted", pool: ctx.pool });
    return unavailable(root, RETRY_POOL_SECONDS, `${ctx.pool} pool exhausted`);
  }
  const code = "code" in root ? root.code : undefined;
  if (
    CONNECTION_LOST.includes(root.message) ||
    (typeof code === "string" && NETWORK_CODES.has(code))
  ) {
    return unavailable(root, RETRY_POOL_SECONDS, `${ctx.pool} connection failed`);
  }
  // Any other driver failure still must not carry drizzle's query text and parameters to logs.
  if (error instanceof DrizzleQueryError) {
    return new AppError("internal", { detail: `${ctx.pool} query failed`, cause: root });
  }
  return error;
}

/** True when Postgres itself answered with an error, so the connection is still usable. */
export function isServerError(error: unknown): boolean {
  return findDatabaseError(error) !== undefined;
}

function fromDatabaseError(pg: DatabaseError, ctx: DbErrorContext): AppError {
  const detail = `pg ${pg.code ?? "unknown"} on ${ctx.pool}`;
  switch (pg.code) {
    case "57014":
      return new AppError("timeout", { detail, cause: pg });
    case "23505":
      return new AppError("conflict", { detail, cause: pg });
    case "42501":
      // A tenant write that RLS rejected is a bug or an attack, never a user mistake.
      emitDbEvent({
        name: "db_rls_violation",
        pool: ctx.pool,
        pgCode: pg.code,
        ...(ctx.reason === undefined ? {} : { reason: ctx.reason }),
      });
      return new AppError("internal", { detail, cause: pg });
    case "53300":
    case "57P03":
      emitDbEvent({ name: "db_compute_unavailable", pool: ctx.pool, pgCode: pg.code });
      return unavailable(pg, RETRY_COMPUTE_SECONDS, detail);
    default:
      return new AppError("internal", { detail, cause: pg });
  }
}

function unavailable(cause: Error, retryAfterSeconds: number, detail: string): AppError {
  return new AppError("service_unavailable", { detail, retryAfterSeconds, cause });
}

// drizzle wraps driver errors in DrizzleQueryError, whose message carries the query and params.
function findDatabaseError(error: unknown): DatabaseError | undefined {
  for (let current = error; current instanceof Error; current = current.cause) {
    if (current instanceof DatabaseError) return current;
  }
  return undefined;
}

function rootCause(error: unknown): unknown {
  let current = error;
  while (current instanceof DrizzleQueryError && current.cause !== undefined) {
    current = current.cause;
  }
  return current;
}
