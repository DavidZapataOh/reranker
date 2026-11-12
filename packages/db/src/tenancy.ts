import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { PgTransactionConfig } from "drizzle-orm/pg-core";
import { AppError } from "./app-error.ts";
import { getDb } from "./client.ts";
import { toDbError } from "./errors.ts";
import type { DbPoolKind } from "./events.ts";

export type TenantId = string & { readonly __brand: "TenantId" };

type Transaction = Parameters<Parameters<NodePgDatabase["transaction"]>[0]>[0];
export type TenantTx = Transaction & { readonly __kind: "tenant" };
export type SystemTx = Transaction & { readonly __kind: "system" };

export type TxOptions = {
  readOnly?: boolean;
  statementTimeoutMs?: number;
  isolation?: "read committed" | "repeatable read" | "serializable";
};

// Free-form but greppable: it is stored in app.system_reason and shows up in audits and logs.
export type SystemReason = string;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SYSTEM_REASON = /^[a-z][a-z0-9_.:-]{1,63}$/;
const MAX_TENANTS = 1000;
const DEFAULT_STATEMENT_TIMEOUT_MS = 5000;

export function asTenantId(value: string): TenantId {
  const normalized = value.toLowerCase();
  if (!UUID.test(normalized)) throw new AppError("internal", { detail: "invalid tenant id" });
  return normalized as TenantId;
}

export function toPgUuidArray(ids: readonly TenantId[]): string {
  return `{${ids.join(",")}}`;
}

export function withTenant<T>(
  tenantId: TenantId,
  fn: (tx: TenantTx) => Promise<T>,
  opts?: TxOptions,
): Promise<T> {
  return withTenants([tenantId], fn, opts);
}

export async function withTenants<T>(
  tenantIds: readonly TenantId[],
  fn: (tx: TenantTx) => Promise<T>,
  opts: TxOptions = {},
): Promise<T> {
  const ids = validateTenantIds(tenantIds);
  const timeout = statementTimeout(opts);
  // Both settings are transaction-local (is_local = true), so they die with COMMIT/ROLLBACK and
  // never leak to the next borrower of the pooled connection. One round trip sets both.
  return run("app", undefined, opts, async (tx) => {
    await tx.execute(
      sql`select set_config('app.tenant_ids', ${toPgUuidArray(ids)}, true), set_config('statement_timeout', ${timeout}, true)`,
    );
    return fn(tx as TenantTx);
  });
}

export async function withSystem<T>(
  reason: SystemReason,
  fn: (tx: SystemTx) => Promise<T>,
  opts: TxOptions = {},
): Promise<T> {
  if (!SYSTEM_REASON.test(reason)) {
    throw new AppError("internal", { detail: "invalid system reason" });
  }
  const timeout = statementTimeout(opts);
  return run("system", reason, opts, async (tx) => {
    await tx.execute(
      sql`select set_config('app.system_reason', ${reason}, true), set_config('statement_timeout', ${timeout}, true)`,
    );
    return fn(tx as SystemTx);
  });
}

async function run<T>(
  pool: DbPoolKind,
  reason: SystemReason | undefined,
  opts: TxOptions,
  body: (tx: Transaction) => Promise<T>,
): Promise<T> {
  try {
    return await getDb(pool).transaction(body, transactionConfig(opts));
  } catch (error) {
    throw toDbError(error, reason === undefined ? { pool } : { pool, reason });
  }
}

function validateTenantIds(tenantIds: readonly TenantId[]): TenantId[] {
  if (tenantIds.length === 0 || tenantIds.length > MAX_TENANTS) {
    throw new AppError("internal", { detail: `expected 1 to ${MAX_TENANTS} tenant ids` });
  }
  // Re-validated because a TenantId can be forged with a cast; casing must not hide duplicates.
  const ids = tenantIds.map(asTenantId);
  if (new Set(ids).size !== ids.length) {
    throw new AppError("internal", { detail: "duplicate tenant ids" });
  }
  return ids;
}

function statementTimeout(opts: TxOptions): string {
  const ms = opts.statementTimeoutMs ?? DEFAULT_STATEMENT_TIMEOUT_MS;
  if (!Number.isInteger(ms) || ms < 1) {
    throw new AppError("internal", { detail: "statementTimeoutMs must be a positive integer" });
  }
  return String(ms);
}

function transactionConfig(opts: TxOptions): PgTransactionConfig | undefined {
  const config: PgTransactionConfig = {};
  if (opts.isolation) config.isolationLevel = opts.isolation;
  if (opts.readOnly) config.accessMode = "read only";
  return Object.keys(config).length > 0 ? config : undefined;
}
