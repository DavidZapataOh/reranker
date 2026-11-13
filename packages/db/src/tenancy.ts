import { AppError, isAppError, Uuid } from "@reranker/schema";
import { type SQL, sql } from "drizzle-orm";
import { drizzle, type NodePgTransaction } from "drizzle-orm/node-postgres";
import type { PgTransactionConfig } from "drizzle-orm/pg-core";
import type { Pool, PoolClient } from "pg";
import { appPool, systemPool } from "./client";
import { toDbError } from "./errors";

export type TenantId = string & { readonly __brand: "TenantId" };

export type TxOptions = {
  readOnly?: boolean;
  statementTimeoutMs?: number;
  isolation?: "read committed" | "repeatable read" | "serializable";
};

// Names the caller in logs and in the transaction itself, e.g. 'auth.claim_free_reports'.
export type SystemReason = string;

type Tx = NodePgTransaction<Record<string, never>, Record<string, never>>;
export type TenantTx = Tx & { readonly __kind: "tenant" };
export type SystemTx = Tx & { readonly __kind: "system" };

const MAX_TENANTS = 1000;
const DEFAULT_STATEMENT_TIMEOUT_MS = 5000;
const MAX_STATEMENT_TIMEOUT_MS = 60_000;
const SYSTEM_REASON = /^[a-z][a-z0-9_.:-]{1,63}$/;

function invalid(detail: string): AppError {
  return new AppError("internal", { detail });
}

export function asTenantId(value: string): TenantId {
  if (typeof value !== "string") throw invalid("invalid tenant id");
  const id = value.toLowerCase();
  if (!Uuid.safeParse(id).success) throw invalid("invalid tenant id");
  return id as TenantId;
}

// The ids are validated uuids, so the literal cannot carry a quote, comma or brace.
export function toPgUuidArray(ids: readonly TenantId[]): string {
  return `{${ids.join(",")}}`;
}

function statementTimeout(opts: TxOptions): string {
  const ms = opts.statementTimeoutMs ?? DEFAULT_STATEMENT_TIMEOUT_MS;
  // Zero would disable the timeout; the cap keeps one transaction from holding a pooled
  // connection far past the login's own safety net.
  if (!Number.isSafeInteger(ms) || ms < 1 || ms > MAX_STATEMENT_TIMEOUT_MS) {
    throw invalid("invalid statementTimeoutMs");
  }
  return String(ms);
}

function txConfig(opts: TxOptions): PgTransactionConfig {
  return {
    ...(opts.isolation && { isolationLevel: opts.isolation }),
    ...(opts.readOnly && { accessMode: "read only" as const }),
  };
}

type Ctx = { pool: "app" | "system"; reason?: SystemReason };

function closedHandle(): AppError {
  return invalid("transaction handle used after its callback settled");
}

// Once the callback settles the connection belongs to the pool again, so a handle or a lazy
// query kept by the caller must never reach it.
function guard(client: PoolClient, isOpen: () => boolean): PoolClient {
  const query = (...args: Parameters<PoolClient["query"]>) => {
    if (!isOpen()) return Promise.reject(closedHandle());
    return (client.query as (...a: unknown[]) => unknown)(...args);
  };
  return { query } as unknown as PoolClient;
}

function seal<T extends object>(tx: T, isOpen: () => boolean): T {
  return new Proxy(tx, {
    get(target, property, receiver) {
      if (!isOpen()) throw closedHandle();
      return Reflect.get(target, property, receiver);
    },
  });
}

// The checkout is owned here rather than by drizzle's pool path, which skips release() when
// BEGIN itself fails and leaks the slot. set_config(..., true) is transaction-local: COMMIT or
// ROLLBACK clears it before the pooler hands the server connection to anyone else. Both settings
// go in one round trip.
async function run<T, K extends "tenant" | "system">(
  pool: Pool,
  ctx: Ctx,
  setup: SQL,
  fn: (tx: Tx & { readonly __kind: K }) => Promise<T>,
  opts: TxOptions,
): Promise<T> {
  let client: PoolClient;
  try {
    client = await pool.connect();
  } catch (error) {
    throw toDbError(error, ctx);
  }
  let open = true;
  const isOpen = () => open;
  const db = drizzle({ client: guard(client, isOpen), casing: "snake_case" });
  let failed: { error: unknown } | undefined;
  // A truthy value makes pg-pool destroy the client instead of reusing it.
  let discard: unknown;
  try {
    return await db.transaction(async (tx) => {
      try {
        await tx.execute(setup);
        return await fn(seal(tx as Tx & { readonly __kind: K }, isOpen));
      } catch (error) {
        failed = { error };
        throw error;
      }
    }, txConfig(opts));
  } catch (error) {
    // Drizzle rethrows the callback's own error after a clean ROLLBACK; anything else means
    // BEGIN, COMMIT or ROLLBACK failed and the session state is unknown.
    const rolledBack = failed !== undefined && error === failed.error;
    const translated = toDbError(failed ? failed.error : error, ctx);
    const broken = isAppError(translated) && translated.code === "service_unavailable";
    if (!rolledBack || broken) discard = error instanceof Error ? error : true;
    throw translated;
  } finally {
    open = false;
    client.release(discard as Error | boolean | undefined);
  }
}

export async function withTenants<T>(
  tenantIds: readonly TenantId[],
  fn: (tx: TenantTx) => Promise<T>,
  opts: TxOptions = {},
): Promise<T> {
  if (tenantIds.length === 0 || tenantIds.length > MAX_TENANTS) {
    throw invalid("tenant id count out of range");
  }
  // Ids can reach here through a cast, so they are normalized again before the set literal.
  const ids = tenantIds.map(asTenantId);
  if (new Set(ids).size !== ids.length) throw invalid("duplicate tenant id");
  const setup = sql`select set_config('app.tenant_ids', ${toPgUuidArray(ids)}, true), set_config('statement_timeout', ${statementTimeout(opts)}, true)`;
  return run(appPool(), { pool: "app" }, setup, fn, opts);
}

export function withTenant<T>(
  tenantId: TenantId,
  fn: (tx: TenantTx) => Promise<T>,
  opts?: TxOptions,
): Promise<T> {
  return withTenants([tenantId], fn, opts);
}

export async function withSystem<T>(
  reason: SystemReason,
  fn: (tx: SystemTx) => Promise<T>,
  opts: TxOptions = {},
): Promise<T> {
  if (!SYSTEM_REASON.test(reason)) throw invalid("invalid system reason");
  // The reason travels with the transaction so pg_stat_activity and audit queries can see it.
  const setup = sql`select set_config('app.system_reason', ${reason}, true), set_config('statement_timeout', ${statementTimeout(opts)}, true)`;
  return run(systemPool(), { pool: "system", reason }, setup, fn, opts);
}
