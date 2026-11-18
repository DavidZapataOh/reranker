import { AppError, isAppError, Uuid } from "@reranker/schema";
import { is, QueryPromise, type SQL, sql } from "drizzle-orm";
import { NodePgSession, NodePgTransaction } from "drizzle-orm/node-postgres";
import { PgDialect, PgSelectBase } from "drizzle-orm/pg-core";
import type { Pool, PoolClient } from "pg";
import { appPool, systemPool } from "./client";
import { toDbError } from "./errors";

export type TenantId = string & { readonly __brand: "TenantId" };

export type TxOptions = {
  readOnly?: boolean;
  statementTimeoutMs?: number;
  /** Bounds every lock wait; one that runs out fails as AppError timeout (55P03). */
  lockTimeoutMs?: number;
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

// Zero would disable a timeout; the cap keeps one transaction from holding a pooled connection
// far past the login's own safety net.
function timeoutMs(ms: number, option: "statementTimeoutMs" | "lockTimeoutMs"): string {
  if (!Number.isSafeInteger(ms) || ms < 1 || ms > MAX_STATEMENT_TIMEOUT_MS) {
    throw invalid(`invalid ${option}`);
  }
  return String(ms);
}

function timeouts(opts: TxOptions): SQL {
  const ms = timeoutMs(
    opts.statementTimeoutMs ?? DEFAULT_STATEMENT_TIMEOUT_MS,
    "statementTimeoutMs",
  );
  const statement = sql`set_config('statement_timeout', ${ms}, true)`;
  if (opts.lockTimeoutMs === undefined) return statement;
  const lock = timeoutMs(opts.lockTimeoutMs, "lockTimeoutMs");
  return sql`${statement}, set_config('lock_timeout', ${lock}, true)`;
}

const ISOLATION_LEVELS: ReadonlySet<string> = new Set<NonNullable<TxOptions["isolation"]>>([
  "read committed",
  "repeatable read",
  "serializable",
]);

// The options can arrive through a cast, and this text goes to the server as is.
function beginStatement(opts: TxOptions): string {
  const { isolation, readOnly } = opts;
  if (isolation !== undefined && !ISOLATION_LEVELS.has(isolation))
    throw invalid("invalid isolation");
  return `begin${isolation ? ` isolation level ${isolation}` : ""}${readOnly ? " read only" : ""}`;
}

type Ctx = { pool: "app" | "system"; reason?: SystemReason };

const dialect = new PgDialect({ casing: "snake_case" });

function closedHandle(): AppError {
  return invalid("transaction handle used after its callback settled");
}

// Once the callback settles the connection belongs to the pool again, so a handle or a lazy
// query kept by the caller must never reach it. `onWrite` runs right after a statement is written.
function guard(client: PoolClient, isOpen: () => boolean, onWrite: () => void): PoolClient {
  const query = (...args: Parameters<PoolClient["query"]>) => {
    if (!isOpen()) return Promise.reject(closedHandle());
    const result = (client.query as (...a: unknown[]) => unknown)(...args);
    onWrite();
    return result;
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

type Outcome = { error: unknown } | undefined;

// The pools pipeline, so BEGIN and the settings are written without waiting and travel with the
// callback's first statement; a callback that returns a single unawaited query also has COMMIT
// written right behind it, and the whole transaction is one round trip. The server still runs
// them in order inside one transaction, so the settings are in place before any statement.
// set_config(..., true) is transaction-local: COMMIT or ROLLBACK clears it before the pooler
// hands the server connection to anyone else, and a client is only returned to the pool idle.
async function run<T, K extends "tenant" | "system">(
  pool: Pool,
  ctx: Ctx,
  setup: SQL,
  fn: (tx: Tx & { readonly __kind: K }) => Promise<T>,
  opts: TxOptions,
): Promise<T> {
  const begin = beginStatement(opts);
  const settings = dialect.sqlToQuery(setup);
  let client: PoolClient;
  try {
    client = await pool.connect();
  } catch (error) {
    throw toDbError(error, ctx);
  }
  // pg-pool listens for errors only on idle clients, and an 'error' event nobody listens to
  // crashes the process. A connection lost mid-transaction already fails its statements.
  client.on("error", ignoreError);
  let open = true;
  const isOpen = () => open;
  let written = 0;
  const send = (text: string, values?: unknown[]): Promise<Outcome> =>
    client.query(text, values).then(
      () => undefined,
      (error: unknown) => ({ error }),
    );
  const session = new NodePgSession(
    guard(client, isOpen, () => {
      written++;
    }),
    dialect,
    undefined,
  );
  const tx = seal(
    new NodePgTransaction(dialect, session, undefined) as Tx & { readonly __kind: K },
    isOpen,
  );

  const began = send(begin);
  const configured = send(settings.sql, settings.params);
  let ended: Promise<Outcome> | undefined;
  let result: { value: T } | { error: unknown };
  try {
    const pending = fn(tx);
    let settled: PromiseLike<T> = pending;
    // A query returned unawaited has not run yet. Starting it here leaves no gap in which other
    // code of the callback could write first, so exactly one statement written now is that query
    // alone and COMMIT can follow it. Selects get QueryPromise as a mixin, outside their class chain.
    if (is(pending, QueryPromise) || is(pending, PgSelectBase)) {
      const before = written;
      settled = new Promise<T>((resolve, reject) => {
        pending.then(resolve, reject);
      });
      if (written === before + 1) {
        ended = send("commit");
        open = false;
      }
    }
    result = { value: await settled };
  } catch (error) {
    result = { error };
  }
  ended ??= send("error" in result ? "rollback" : "commit");

  const [beginFailed, setupFailed, endFailed] = await Promise.all([began, configured, ended]);
  // A failed BEGIN, COMMIT or ROLLBACK leaves the session state unknown.
  let discard: unknown = beginFailed ?? endFailed;
  try {
    const failure =
      beginFailed ?? setupFailed ?? ("error" in result ? result : undefined) ?? endFailed;
    if (failure) {
      const translated = toDbError(failure.error, ctx);
      if (isAppError(translated) && translated.code === "service_unavailable") discard = failure;
      throw translated;
    }
    return (result as { value: T }).value;
  } finally {
    open = false;
    if (client.getTransactionStatus() !== "I") discard = true;
    client.removeListener("error", ignoreError);
    // A truthy value makes pg-pool destroy the client instead of reusing it.
    client.release(discard === undefined ? undefined : toReleaseError(discard));
  }
}

function ignoreError(): void {}

function toReleaseError(discard: unknown): Error | true {
  const error = (discard as { error?: unknown }).error;
  return error instanceof Error ? error : true;
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
  const setup = sql`select set_config('app.tenant_ids', ${toPgUuidArray(ids)}, true), ${timeouts(opts)}`;
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
  const setup = sql`select set_config('app.system_reason', ${reason}, true), ${timeouts(opts)}`;
  return run(systemPool(), { pool: "system", reason }, setup, fn, opts);
}
