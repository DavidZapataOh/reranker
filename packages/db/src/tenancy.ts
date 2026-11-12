import { AppError, Uuid } from "@reranker/schema";
import { type ExtractTablesWithRelations, sql } from "drizzle-orm";
import { drizzle, type NodePgTransaction } from "drizzle-orm/node-postgres";
import type { PgTransactionConfig } from "drizzle-orm/pg-core";
import type pg from "pg";
import { pool } from "./client.ts";
import { isServerError, toDbError } from "./errors.ts";
import type { DbPool } from "./events.ts";
import * as schema from "./schema/index.ts";

type Schema = typeof schema;

export type TenantId = string & { readonly __brand: "TenantId" };

/** Why system code bypasses tenant isolation, e.g. "auth", "auth.claim_free_reports", "jobs.lease". */
export type SystemReason = string;

export type TxOptions = {
  readOnly?: boolean;
  /** Per transaction; defaults to 5000. */
  statementTimeoutMs?: number;
  isolation?: "read committed" | "repeatable read" | "serializable";
};

type Transaction = NodePgTransaction<Schema, ExtractTablesWithRelations<Schema>>;
declare const txKind: unique symbol;
/** A transaction on reranker_app with app.tenant_ids set: RLS limits it to those tenants. */
export type TenantTx = Transaction & { readonly [txKind]: "tenant" };
/** A transaction on reranker_system: no tenant limit, only for the reason it was opened with. */
export type SystemTx = Transaction & { readonly [txKind]: "system" };

const MAX_TENANTS = 1000;
const DEFAULT_STATEMENT_TIMEOUT_MS = 5000;
const MAX_STATEMENT_TIMEOUT_MS = 60_000;
const SYSTEM_REASON = /^[a-z][a-z0-9_.:-]{1,63}$/;

export function asTenantId(value: string): TenantId {
  const parsed = Uuid.safeParse(value);
  if (!parsed.success) throw new AppError("internal", { detail: "invalid tenant id" });
  return parsed.data as TenantId;
}

/** Internal: the literal app.current_tenant_ids() casts to uuid[]. Ids are validated uuids. */
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
  if (tenantIds.length === 0 || tenantIds.length > MAX_TENANTS) {
    throw new AppError("internal", { detail: `withTenants needs 1 to ${MAX_TENANTS} tenant ids` });
  }
  // Re-validated because a cast can forge a TenantId; normalizing exposes case-only duplicates.
  const ids = tenantIds.map(asTenantId);
  if (new Set(ids).size !== ids.length) {
    throw new AppError("internal", { detail: "withTenants received duplicate tenant ids" });
  }
  const timeout = statementTimeout(opts);
  return run("app", opts, { pool: "app" }, async (tx) => {
    // One round trip; is_local makes both values die with COMMIT or ROLLBACK, so a pooled
    // connection never carries them into the next transaction.
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
    throw new AppError("internal", { detail: "withSystem needs a reason like 'auth.claim'" });
  }
  const timeout = statementTimeout(opts);
  return run("system", opts, { pool: "system", reason }, async (tx) => {
    // The reason stays visible to the transaction (and to anything logging it) for audits.
    await tx.execute(
      sql`select set_config('app.system_reason', ${reason}, true), set_config('statement_timeout', ${timeout}, true)`,
    );
    return fn(tx as SystemTx);
  });
}

async function run<T>(
  kind: DbPool,
  opts: TxOptions,
  ctx: { pool: DbPool; reason?: string },
  body: (tx: Transaction) => Promise<T>,
): Promise<T> {
  const config: PgTransactionConfig = {};
  if (opts.isolation !== undefined) config.isolationLevel = opts.isolation;
  if (opts.readOnly === true) config.accessMode = "read only";

  let client: pg.PoolClient;
  try {
    client = await pool(kind).connect();
  } catch (error) {
    throw toDbError(error, ctx);
  }
  // The client is checked out here, not by drizzle: drizzle releases it only when BEGIN succeeds,
  // so a failed BEGIN would keep a pool slot forever.
  let bodyError: unknown = NO_ERROR;
  let broken = false;
  try {
    return await drizzle({ client, schema, casing: "snake_case" }).transaction(
      async (tx) => {
        try {
          return await body(tx);
        } catch (error) {
          bodyError = error;
          throw error;
        }
      },
      Object.keys(config).length > 0 ? config : undefined,
    );
  } catch (error) {
    // The body's own error means ROLLBACK ran and the connection is clean. A server error from
    // BEGIN, COMMIT or ROLLBACK leaves it usable too. Anything else (socket closed, protocol
    // error) leaves its state unknown, so the client is destroyed instead of reused.
    broken = error !== bodyError && !isServerError(error);
    throw toDbError(error, ctx);
  } finally {
    client.release(broken);
  }
}

const NO_ERROR = Symbol("no error");

function statementTimeout(opts: TxOptions): string {
  const ms = opts.statementTimeoutMs ?? DEFAULT_STATEMENT_TIMEOUT_MS;
  if (!Number.isInteger(ms) || ms < 1 || ms > MAX_STATEMENT_TIMEOUT_MS) {
    throw new AppError("internal", {
      detail: `statementTimeoutMs must be an integer from 1 to ${MAX_STATEMENT_TIMEOUT_MS}`,
    });
  }
  return String(ms);
}
