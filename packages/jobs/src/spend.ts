import { withSystem } from "@reranker/db";
import { appEnv } from "@reranker/env";
import { type CountryCode, DEFAULT_COUNTRY_CODE } from "@reranker/i18n/countries";
import {
  AppError,
  type CaptureChannel,
  cost,
  DateOnly,
  type EngineId,
  type ProviderCost,
  ProviderCostSchema,
  Uuid,
} from "@reranker/schema";
import { type SQL, sql } from "drizzle-orm";
import { type JobsConfig, loadJobsConfig } from "./config";
import { nextResetAt, spendDay } from "./day";
import { InvalidInputError, SpendCapExceededError } from "./errors";
import type { PaidProvider, SpendPool, SpendPurpose } from "./providers";

export interface SpendRequest {
  provider: PaidProvider;
  channel?: CaptureChannel;
  engine?: EngineId;
  purpose: SpendPurpose;
  /** Required for the free report and only there: the pool it draws on first. */
  pool?: SpendPool;
  /** Only beside `pool`: the pool that covers the reservation when its own pool is short. */
  fallbackPool?: SpendPool;
  /** Required for the free report and only there: outside the priority country it also draws on the elsewhere pool. */
  country?: CountryCode;
  refType: string;
  refId: string;
  estimate: ProviderCost;
}

export interface SpendScopeStatus {
  scope: string;
  used: ProviderCost;
  cap: ProviderCost;
}

export interface SpendReservation {
  id: string;
  reserved: ProviderCost;
  provider: PaidProvider;
  purpose: SpendPurpose;
  /** Every scope charged, global first, with its used amount and cap right after reserving. */
  scopes: readonly SpendScopeStatus[];
}

/** Catalog events of settling, for the caller to send; this package has no telemetry of its own. */
export type SpendEvent = {
  name: "jobs.spend.settled";
  props: { provider: PaidProvider; purpose: SpendPurpose; micro_usd: number };
};

const INVALID_PARAMETER = "22023";
const POOLS: readonly (string | undefined)[] = [
  "free-report-anonymous",
  "free-report-verified",
  undefined,
] satisfies readonly (SpendPool | undefined)[];
const ELSEWHERE_SCOPE = "pool:free-report-elsewhere";

// A parameter the database rejects (a currency other than the day's counters) is invalid input,
// never an outage.
async function system<T>(fn: Parameters<typeof withSystem<T>>[1]): Promise<T> {
  try {
    return await withSystem("jobs.spend", fn);
  } catch (error) {
    const cause =
      error instanceof AppError ? (error.cause as { code?: string } | undefined) : undefined;
    if (cause?.code === INVALID_PARAMETER) throw new InvalidInputError("Spend parameters rejected");
    throw error;
  }
}

function capOf(config: JobsConfig, scope: string): ProviderCost {
  if (!Object.hasOwn(config.caps, scope)) throw new InvalidInputError(`No spend cap for ${scope}`);
  return config.caps[scope as keyof JobsConfig["caps"]];
}

function assertAmount(amount: ProviderCost, currency: string): void {
  if (!ProviderCostSchema.safeParse(amount).success || amount.currency !== currency) {
    throw new InvalidInputError(`Spend must be whole ${currency} micro-units`);
  }
}

function currencyOf(config: JobsConfig = loadJobsConfig()): ProviderCost["currency"] {
  return config.caps.global.currency;
}

function assertReservation(r: SpendReservation): void {
  if (!Uuid.safeParse(r.id).success) throw new InvalidInputError("Unknown spend reservation");
}

// Global comes first and sorts first, so every spend function of a day locks that day's global
// counter before any other and none can deadlock. The rest go from the narrowest scope to the
// widest, so a denial names the most specific cap that is full.
function scopesFor(req: SpendRequest): string[] {
  const freeReport = req.purpose === "free-report";
  // Every free report is admitted into a pool and has a country; without them it would spend
  // outside the pool caps and the priority country's share.
  if (freeReport !== (req.pool !== undefined) || freeReport !== (req.country !== undefined)) {
    throw new InvalidInputError("The free report, and only it, needs a pool and a country");
  }
  // The elsewhere pool follows the country; no caller picks it.
  if (!POOLS.includes(req.pool) || !POOLS.includes(req.fallbackPool)) {
    throw new InvalidInputError("Unknown spend pool");
  }
  if (req.fallbackPool !== undefined && (req.pool === undefined || req.fallbackPool === req.pool)) {
    throw new InvalidInputError(
      "A fallback pool stands in for a different pool of the reservation",
    );
  }
  const scopes = ["global"];
  if (req.pool !== undefined) scopes.push(`pool:${req.pool}`);
  if (req.country !== undefined && req.country !== DEFAULT_COUNTRY_CODE) {
    scopes.push(ELSEWHERE_SCOPE);
  }
  scopes.push(`purpose:${req.purpose}`);
  // Outside production every real provider is capped at zero; contract tests still reach the
  // providers there, under their own purpose cap.
  if (req.purpose !== "contract-test" || appEnv() === "production") {
    scopes.push(`provider:${req.provider}`);
  }
  return scopes;
}

type ReserveRow = {
  ledger_id: string | null;
  denied_scope: string | null;
  scopes: string[];
  used: string[];
  caps: string[];
};

/**
 * Charges the estimate to every scope of the request (global, provider, purpose and pools) or to
 * none, in one transaction. Reserve, call the provider and settle or release in the same durable
 * step: a reservation older than 15 minutes counts as abandoned and is released.
 *
 * A denial's scope is the first cap found full, enough for logs and alerts. Admission decisions
 * (live, reduced, verify or defer) read `spendStatus` of the scopes they care about instead.
 */
export async function reserveSpend(req: SpendRequest): Promise<SpendReservation> {
  const config = loadJobsConfig();
  const currency = currencyOf(config);
  assertAmount(req.estimate, currency);
  // A zero amount passes every cap, a full one too, so it would spend without any limit.
  if (req.estimate.amount_micros === 0) {
    throw new InvalidInputError("Spend estimate must be positive");
  }
  if (!req.refType || !req.refId) throw new InvalidInputError("Spend needs a reference");
  // Checked even for contract tests outside production, whose provider cap does not apply.
  capOf(config, `provider:${req.provider}`);
  const scopes = scopesFor(req);
  const caps = scopes.map((scope) => capOf(config, scope).amount_micros);
  const ownPool = req.pool === undefined ? null : `pool:${req.pool}`;
  const fallback = req.fallbackPool === undefined ? null : `pool:${req.fallbackPool}`;
  const fallbackCap = fallback === null ? null : capOf(config, fallback).amount_micros;

  const now = new Date();
  const ledger = {
    provider: req.provider,
    channel: req.channel ?? null,
    engine: req.engine ?? null,
    purpose: req.purpose,
    pool: req.pool ?? null,
    ref_type: req.refType,
    ref_id: req.refId,
    currency,
  };
  const { rows } = await system((tx) =>
    tx.execute<ReserveRow>(
      sql`select * from ops.reserve_spend(${spendDay(now)}::date, ${sql.param(scopes)}::text[],
        ${sql.param(caps)}::bigint[], ${fallback}::text, ${fallbackCap}::bigint,
        ${req.estimate.amount_micros}::bigint, ${JSON.stringify(ledger)}::jsonb)`,
    ),
  );
  const row = rows[0];
  if (!row) throw new Error("reserve_spend returned no row");
  if (row.ledger_id === null) {
    if (row.denied_scope === null) throw new Error("reserve_spend denied without a scope");
    // The fallback is tried only after the reservation's own pool came up short, so a denial that
    // names the fallback means the own pool is full as well; callers decide on the own pool.
    const scope = row.denied_scope === fallback && ownPool ? ownPool : row.denied_scope;
    throw new SpendCapExceededError(scope, nextResetAt(now));
  }
  return {
    id: row.ledger_id,
    reserved: cost(req.estimate.amount_micros, currency),
    provider: req.provider,
    purpose: req.purpose,
    scopes: row.scopes.map((scope, i) => ({
      scope,
      used: cost(Number(row.used[i]), currency),
      cap: cost(Number(row.caps[i]), currency),
    })),
  };
}

async function applied(query: SQL, fn: string): Promise<{ applied: boolean }> {
  const { rows } = await system((tx) => tx.execute<{ applied: boolean }>(query));
  const row = rows[0];
  if (!row) throw new Error(`${fn} returned no row`);
  return { applied: row.applied };
}

/**
 * Replaces the reservation with what the provider actually charged, on the reservation's day and
 * even past the cap. Settle in the same durable step as the provider call that charges (with
 * DataForSEO Standard, on the cost `task_post` reports), never in a later step that may start
 * more than 15 minutes after reserving: by then the reservation counts as abandoned, has been
 * released, and the settle is not applied.
 *
 * `applied` is false when the reservation was already settled or released: a retried step changes
 * nothing, and a false on the first settle means the actual cost went unrecorded.
 */
export async function settleSpend(
  r: SpendReservation,
  actual: ProviderCost,
  opts: { onEvent?: (event: SpendEvent) => void } = {},
): Promise<{ applied: boolean }> {
  assertReservation(r);
  assertAmount(actual, currencyOf());
  const result = await applied(
    sql`select ops.settle_spend(${r.id}::uuid, ${actual.amount_micros}::bigint) as applied`,
    "settle_spend",
  );
  if (result.applied) {
    opts.onEvent?.({
      name: "jobs.spend.settled",
      props: { provider: r.provider, purpose: r.purpose, micro_usd: actual.amount_micros },
    });
  }
  return result;
}

/** Gives the whole reservation back when the provider charged nothing; idempotent like settle. */
export async function releaseSpend(r: SpendReservation): Promise<{ applied: boolean }> {
  assertReservation(r);
  return applied(sql`select ops.release_spend(${r.id}::uuid) as applied`, "release_spend");
}

/**
 * Releases the day's reservations older than 15 minutes, left by functions that died before
 * settling. Reserving does this on its own when a cap looks full; the daily reconciliation calls
 * it for the days nobody reserves on any more.
 */
export async function releaseStaleSpend(day: string): Promise<number> {
  if (!DateOnly.safeParse(day).success) throw new InvalidInputError("Spend day must be YYYY-MM-DD");
  const { rows } = await system((tx) =>
    tx.execute<{ released: number }>(
      sql`select ops.release_stale_reservations(${day}::date, interval '15 minutes') as released`,
    ),
  );
  return rows[0]?.released ?? 0;
}

/** Today's cap and use of each scope, in the order asked; a scope with no spend yet reads zero. */
export async function spendStatus(
  scopes: string[],
): Promise<Array<{ scope: string; cap: ProviderCost; used: ProviderCost; resetsAt: Date }>> {
  const config = loadJobsConfig();
  const caps = scopes.map((scope) => capOf(config, scope));
  const now = new Date();
  const { rows } = await system((tx) =>
    tx.execute<{ scope: string; used: string }>(
      sql`select scope, used_amount_micros as used from ops.spend_counters
           where day = ${spendDay(now)}::date and scope = any (${sql.param(scopes)}::text[])`,
    ),
  );
  const used = new Map(rows.map((row) => [row.scope, Number(row.used)]));
  const resetsAt = nextResetAt(now);
  return scopes.map((scope, i) => {
    const cap = caps[i] as ProviderCost;
    return { scope, cap, used: cost(used.get(scope) ?? 0, cap.currency), resetsAt };
  });
}

/** What a piece of work cost: the sum of its settled actuals. */
export async function costOf(refType: string, refId: string): Promise<ProviderCost> {
  const currency = currencyOf();
  const { rows } = await system((tx) =>
    tx.execute<{ total: string }>(
      sql`select coalesce(sum(actual_amount_micros), 0)::bigint as total from ops.spend_ledger
           where ref_type = ${refType} and ref_id = ${refId} and status = 'settled'`,
    ),
  );
  return cost(Number(rows[0]?.total ?? 0), currency);
}
