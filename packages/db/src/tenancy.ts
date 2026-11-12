import { AppError, isAppError, Uuid } from "@reranker/schema";
import { type ExtractTablesWithRelations, type SQL, sql } from "drizzle-orm";
import { drizzle, type NodePgTransaction } from "drizzle-orm/node-postgres";
import type { PgTransactionConfig } from "drizzle-orm/pg-core";
import type pg from "pg";
import { getPool, type PoolName } from "./client.ts";
import { pgErrorCode, toDbError } from "./errors.ts";
import * as schema from "./schema/index.ts";

export type DbSchema = typeof schema;
type Transaction = NodePgTransaction<DbSchema, ExtractTablesWithRelations<DbSchema>>;

export type TenantId = string & { readonly __brand: "TenantId" };
export type TenantTx = Transaction & { readonly __kind: "tenant" };
export type SystemTx = Transaction & { readonly __kind: "system" };
// What the system access is for, recorded in the transaction: 'auth', 'auth.claim_free_reports', 'jobs.lease', …
export type SystemReason = string;
export type TxOptions = {
  readOnly?: boolean;
  statementTimeoutMs?: number;
  isolation?: "read committed" | "repeatable read" | "serializable";
};

const DEFAULT_STATEMENT_TIMEOUT_MS = 5000;
const MAX_STATEMENT_TIMEOUT_MS = 60_000;
const MAX_TENANTS = 1000;
const SYSTEM_REASON = /^[a-z][a-z0-9_.:-]{1,63}$/;

const invalid = (detail: string) => new AppError("internal", { detail });

export function asTenantId(value: string): TenantId {
  const normalized = value.toLowerCase();
  if (!Uuid.safeParse(normalized).success) throw invalid("tenant id is not a uuid");
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
  return run(
    "app",
    sql`select set_config('app.tenant_ids', ${toPgUuidArray(ids)}, true), set_config('statement_timeout', ${timeout}, true)`,
    (tx) => fn(tx as TenantTx),
    opts,
    {},
  );
}

export async function withSystem<T>(
  reason: SystemReason,
  fn: (tx: SystemTx) => Promise<T>,
  opts: TxOptions = {},
): Promise<T> {
  if (!SYSTEM_REASON.test(reason)) throw invalid("system reason is malformed");
  const timeout = statementTimeout(opts);
  return run(
    "system",
    sql`select set_config('app.system_reason', ${reason}, true), set_config('statement_timeout', ${timeout}, true)`,
    (tx) => fn(tx as SystemTx),
    opts,
    { reason },
  );
}

function validateTenantIds(tenantIds: readonly TenantId[]): TenantId[] {
  if (tenantIds.length === 0) throw invalid("no tenant ids");
  if (tenantIds.length > MAX_TENANTS) throw invalid(`more than ${MAX_TENANTS} tenant ids`);
  // Ids may arrive cast instead of through asTenantId, so they are normalized and checked again.
  const ids = tenantIds.map((id) => asTenantId(id));
  if (new Set(ids).size !== ids.length) throw invalid("duplicate tenant ids");
  return ids;
}

function statementTimeout({
  statementTimeoutMs = DEFAULT_STATEMENT_TIMEOUT_MS,
}: TxOptions): string {
  if (
    !Number.isInteger(statementTimeoutMs) ||
    statementTimeoutMs < 1 ||
    statementTimeoutMs > MAX_STATEMENT_TIMEOUT_MS
  ) {
    throw invalid("statement timeout out of range");
  }
  return String(statementTimeoutMs);
}

function transactionConfig({ readOnly, isolation }: TxOptions): PgTransactionConfig | undefined {
  if (readOnly === undefined && isolation === undefined) return undefined;
  return {
    ...(isolation === undefined ? {} : { isolationLevel: isolation }),
    ...(readOnly === undefined ? {} : { accessMode: readOnly ? "read only" : "read write" }),
  };
}

// A failed ROLLBACK replaces the original error, so an AppError from fn or a statement-level SQLSTATE
// means the rollback ran on a healthy connection. Connection-class errors (08xxx, 57P0x) or anything
// unexplained retire the client instead of pooling it.
function connectionIsReusable(error: unknown): boolean {
  if (isAppError(error)) return true;
  const code = pgErrorCode(error);
  return code !== undefined && /^[0-9A-Z]{5}$/.test(code) && !/^(08|57P0)/.test(code);
}

async function run<T>(
  poolName: PoolName,
  settings: SQL,
  fn: (tx: Transaction) => Promise<T>,
  opts: TxOptions,
  ctx: { reason?: string },
): Promise<T> {
  const errorContext = { pool: poolName, ...ctx };
  let client: pg.PoolClient;
  try {
    client = await getPool(poolName).connect();
  } catch (error) {
    throw toDbError(error, errorContext);
  }
  // The client is owned here rather than by a pool-level drizzle instance so a broken connection is
  // destroyed instead of handed to the next request.
  let release: Error | undefined;
  try {
    const db = drizzle({ client, schema, casing: "snake_case" });
    return await db.transaction(async (tx) => {
      // One round trip; is_local = true dies with COMMIT/ROLLBACK, so nothing leaks through the pooler.
      await tx.execute(settings);
      return fn(tx);
    }, transactionConfig(opts));
  } catch (error) {
    if (!connectionIsReusable(error)) {
      release = error instanceof Error ? error : new Error("transaction failed");
    }
    throw toDbError(error, errorContext);
  } finally {
    client.release(release);
  }
}
