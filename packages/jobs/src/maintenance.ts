import { withSystem } from "@reranker/db";
import { DEFAULT_COUNTRY_CODE, getCountry } from "@reranker/i18n/countries";
import { cost, DateOnly, type ProviderCost, ProviderCostSchema } from "@reranker/schema";
import { sql } from "drizzle-orm";
import { loadJobsConfig } from "./config";
import { InvalidInputError } from "./errors";
import type { PaidProvider } from "./providers";
import { BUCKET_IDLE_SECONDS } from "./rate";
import { createRegistry } from "./registry";
import { releaseStaleSpend } from "./spend";

/**
 * One entry of the daily maintenance run, in the order the run takes them. `run` is a step
 * function (`"use step"`), so it executes outside the workflow sandbox and is retried on its own;
 * a failure stops the steps after it only when `critical`.
 */
export interface DailyStep {
  name: string;
  run: (date: string) => Promise<void>;
  critical?: boolean;
}

/** What a provider says it charged on a day; the reconciliation compares it with the ledger. */
export interface SpendSource {
  usage(day: string): Promise<ProviderCost>;
}

export interface SpendMismatch {
  provider: PaidProvider;
  ledger: ProviderCost;
  provider_reported: ProviderCost;
}

/** Raised when the month's workflow spend reaches a budget line; the payload has no personal data. */
export interface WorkflowBudgetAlert {
  kind: "jobs-workflow-budget";
  payload: Record<string, string | number | boolean>;
}

export interface WorkflowBudget {
  estimatedEvents: number;
  spendUsd: number;
  budgetUsd: number;
  ratio: number;
}

const TIME_ZONE = getCountry(DEFAULT_COUNTRY_CODE).timeZone;
const VELOCITY_RETENTION_DAYS = 8;

// A gap counts only when it is large both in share and in money, so cents of rounding on a quiet
// day and a few percent of noise on a busy one stay out of the error logs.
const MISMATCH_SHARE = 0.05;
const MISMATCH_MIN_MICROS = 500_000;

// Pro bills every workflow event on demand, https://vercel.com/docs/workflows/pricing (read
// 2026-11-17).
const USD_PER_WORKFLOW_EVENT = 0.02 / 1000;
const BUDGET_LINES = [
  { percent: 100, severity: "critical" },
  { percent: 70, severity: "warning" },
] as const;
// Events a run of each kind writes at most: 3 for the run and 3 per step, plus retries.
const EVENTS_PER_RUN: Readonly<Record<string, number>> = {
  daily: 45,
  "free-report": 85,
  job: 9,
};
// A kind nobody budgeted yet counts as the most expensive, so new work never hides usage.
const UNBUDGETED_EVENTS_PER_RUN = Math.max(...Object.values(EVENTS_PER_RUN));

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

async function system<T>(fn: Parameters<typeof withSystem<T>>[1]): Promise<T> {
  return withSystem("jobs.maintenance", fn);
}

type CleanupRow = { leases: number; buckets: number; velocity: number; breaker_windows: number };

/**
 * Deletes what the capacity primitives leave behind and only clean lazily per key: expired
 * leases, buckets idle long enough to be full again (their HMAC keys go with them), velocity
 * minutes the 7-day baseline no longer reads and breaker windows older than the minute it reads.
 */
export async function cleanupLeases(): Promise<{
  leases: number;
  buckets: number;
  velocity: number;
  breakerWindows: number;
}> {
  const { rows } = await system((tx) =>
    tx.execute<CleanupRow>(
      sql`with leases as (
            delete from ops.concurrency_leases where expires_at <= clock_timestamp() returning 1
          ), buckets as (
            delete from ops.rate_buckets
             where updated_at < clock_timestamp() - make_interval(secs => ${BUCKET_IDLE_SECONDS})
            returning 1
          ), velocity as (
            delete from ops.velocity_buckets
             where bucket_start < clock_timestamp() - make_interval(days => ${VELOCITY_RETENTION_DAYS})
            returning 1
          ), breaker_windows as (
            delete from ops.breaker_windows
             where bucket_start <= date_bin('10 seconds', clock_timestamp(), timestamptz '1970-01-01 00:00:00+00')
                                   - interval '60 seconds'
            returning 1
          )
          select (select count(*) from leases)::int as leases,
                 (select count(*) from buckets)::int as buckets,
                 (select count(*) from velocity)::int as velocity,
                 (select count(*) from breaker_windows)::int as breaker_windows`,
    ),
  );
  const row = rows[0];
  if (!row) throw new Error("cleanup returned no row");
  return {
    leases: row.leases,
    buckets: row.buckets,
    velocity: row.velocity,
    breakerWindows: row.breaker_windows,
  };
}

const spendSources = createRegistry<SpendSource>("spend source");

/** Registered at import by the module that talks to the provider's billing or balance API. */
export function registerSpendSource(provider: PaidProvider, source: SpendSource): void {
  spendSources.register(provider, source);
}

/**
 * Closes a spend day: releases its reservations older than 15 minutes, then compares what the
 * ledger settled per provider with what each registered source says the provider charged. A run
 * changes nothing the second time, so a duplicated cron delivery is harmless.
 */
export async function reconcileSpend(day: string): Promise<{
  released: number;
  mismatches: SpendMismatch[];
}> {
  if (!DateOnly.safeParse(day).success) throw new InvalidInputError("Spend day must be YYYY-MM-DD");
  const released = await releaseStaleSpend(day);
  const sources = [...spendSources.entries()] as [PaidProvider, SpendSource][];
  if (sources.length === 0) return { released, mismatches: [] };

  const currency = loadJobsConfig().caps.global.currency;
  const [settled, reported] = await Promise.all([
    system((tx) =>
      tx.execute<{ provider: string; total: string }>(
        sql`select provider, sum(actual_amount_micros)::bigint as total from ops.spend_ledger
             where day = ${day}::date and status = 'settled'
             group by provider`,
      ),
    ),
    Promise.all(sources.map(([, source]) => source.usage(day))),
  ]);
  const ledgerOf = new Map(settled.rows.map((row) => [row.provider, Number(row.total)]));

  const mismatches: SpendMismatch[] = [];
  sources.forEach(([provider], i) => {
    const providerReported = reported[i] as ProviderCost;
    if (
      !ProviderCostSchema.safeParse(providerReported).success ||
      providerReported.currency !== currency
    ) {
      throw new InvalidInputError(`Spend source for ${provider} must report ${currency}`);
    }
    const ledger = ledgerOf.get(provider) ?? 0;
    const gap = Math.abs(providerReported.amount_micros - ledger);
    if (gap > MISMATCH_MIN_MICROS && gap > MISMATCH_SHARE * ledger) {
      mismatches.push({
        provider,
        ledger: cost(ledger, currency),
        provider_reported: providerReported,
      });
    }
  });
  return { released, mismatches };
}

const round = (n: number, digits: number) => Math.round(n * 10 ** digits) / 10 ** digits;

/**
 * Estimates the month's workflow events from the runs started in the country's month (Vercel
 * exposes no usage endpoint for them), prices them, and alerts from 70% of the monthly budget,
 * critically from 100%.
 */
export async function checkWorkflowBudget(
  month: string,
  opts: { onAlert?: (alert: WorkflowBudgetAlert) => void; budgetUsd?: number } = {},
): Promise<WorkflowBudget> {
  if (!MONTH.test(month)) throw new InvalidInputError("Month must be YYYY-MM");
  const budgetUsd = opts.budgetUsd ?? loadJobsConfig().budgets.workflowsMonthlyUsd;
  const { rows } = await system((tx) =>
    tx.execute<{ kind: string; runs: number }>(
      sql`select kind, count(*)::int as runs from ops.workflow_starts
           where status = 'started'
             and created_at >= ${`${month}-01`}::date::timestamp at time zone ${TIME_ZONE}
             and created_at < (${`${month}-01`}::date + interval '1 month') at time zone ${TIME_ZONE}
           group by kind`,
    ),
  );
  const estimatedEvents = rows.reduce(
    (sum, row) => sum + row.runs * (EVENTS_PER_RUN[row.kind] ?? UNBUDGETED_EVENTS_PER_RUN),
    0,
  );
  const spendUsd = round(estimatedEvents * USD_PER_WORKFLOW_EVENT, 6);
  const ratio = budgetUsd > 0 ? round(spendUsd / budgetUsd, 6) : spendUsd > 0 ? 1 : 0;
  const line = BUDGET_LINES.find((l) => ratio * 100 >= l.percent);
  if (line) {
    opts.onAlert?.({
      kind: "jobs-workflow-budget",
      payload: {
        month,
        estimated_events: estimatedEvents,
        spend_usd: round(spendUsd, 2),
        budget_usd: budgetUsd,
        percent: Math.round(ratio * 100),
        threshold: line.percent,
        severity: line.severity,
      },
    });
  }
  return { estimatedEvents, spendUsd, budgetUsd, ratio };
}
