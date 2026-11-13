import { AppError, Uuid } from "@reranker/schema";
import { type SQL, sql } from "drizzle-orm";
import type { NodePgDatabase, NodePgTransaction } from "drizzle-orm/node-postgres";
import type { PgTransactionConfig } from "drizzle-orm/pg-core";
import { appDb, systemDb } from "./client";
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
const SYSTEM_REASON = /^[a-z][a-z0-9_.:-]{1,63}$/;

function invalid(detail: string): AppError {
  return new AppError("internal", { detail });
}

export function asTenantId(value: string): TenantId {
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
  // Zero would disable the timeout for the whole transaction.
  if (!Number.isSafeInteger(ms) || ms < 1) throw invalid("invalid statementTimeoutMs");
  return String(ms);
}

function txConfig(opts: TxOptions): PgTransactionConfig {
  return {
    ...(opts.isolation && { isolationLevel: opts.isolation }),
    ...(opts.readOnly && { accessMode: "read only" as const }),
  };
}

// set_config(..., true) is transaction-local: COMMIT or ROLLBACK clears it before the pooler
// hands the server connection to anyone else. Both settings go in one round trip.
async function run<T, K extends "tenant" | "system">(
  db: NodePgDatabase,
  setup: SQL,
  fn: (tx: Tx & { readonly __kind: K }) => Promise<T>,
  opts: TxOptions,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(setup);
    return fn(tx as Tx & { readonly __kind: K });
  }, txConfig(opts));
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
  try {
    return await run(appDb(), setup, fn, opts);
  } catch (error) {
    throw toDbError(error, { pool: "app" });
  }
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
  try {
    return await run(systemDb(), setup, fn, opts);
  } catch (error) {
    throw toDbError(error, { pool: "system", reason });
  }
}
