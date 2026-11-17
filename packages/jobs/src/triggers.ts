import { withSystem } from "@reranker/db";
import { DateOnly } from "@reranker/schema";
import { sql } from "drizzle-orm";
import { InvalidInputError } from "./errors";
import { guardModeSince, tripGuardMode } from "./guard-mode";
import { probeSpendPath } from "./latency";

/**
 * Volume triggers of the provider tier upgrades: each one says when the lighter primitive in use
 * stops being enough. Raised through `onAlert`; the payloads carry no personal data.
 */
export interface ScaleTriggerAlert {
  kind: "spend-cap-pressure" | "primitive-latency" | "provider-volume";
  payload: Record<string, string | number | boolean>;
}

type OnAlert = { onAlert?: (alert: ScaleTriggerAlert) => void };

const DAY_MS = 86_400_000;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

const FREE_REPORT_SCOPE = "purpose:free-report";
const PRESSURE_RATIO = 0.7;
const PRESSURE_DAYS = 3;

const LATENCY_BUDGET_MS = 25;
const LATENCY_PROBE_CALLS = 50;
// One reading a day: the mode outlives a day so consecutive readings chain, and lapses after a
// day within budget.
const LATENCY_MODE = "trigger:primitive-latency";
const LATENCY_HOLD_MS = 36 * 3_600_000;
const LATENCY_DAYS = 7;

const PROVIDER_CALLS_PER_MONTH = 2_000_000;

async function system<T>(fn: Parameters<typeof withSystem<T>>[1]): Promise<T> {
  return withSystem("jobs.triggers", fn);
}

const daysBefore = (day: string, n: number) =>
  new Date(Date.parse(`${day}T00:00:00Z`) - n * DAY_MS).toISOString().slice(0, 10);

export interface SpendCapPressure {
  days: { day: string; ratio: number }[];
  fired: boolean;
}

/** The free report's use of its daily cap on `day` and the two days before. */
export async function spendCapPressure(day: string): Promise<SpendCapPressure> {
  if (!DateOnly.safeParse(day).success) throw new InvalidInputError("Day must be YYYY-MM-DD");
  const first = daysBefore(day, PRESSURE_DAYS - 1);
  const { rows } = await system((tx) =>
    tx.execute<{ day: string; used_amount_micros: string; cap_amount_micros: string }>(
      sql`select day::text as day, used_amount_micros, cap_amount_micros from ops.spend_counters
           where scope = ${FREE_REPORT_SCOPE} and day between ${first}::date and ${day}::date`,
    ),
  );
  const byDay = new Map(rows.map((row) => [row.day, row]));
  const days = Array.from({ length: PRESSURE_DAYS }, (_, i) => {
    const d = daysBefore(day, PRESSURE_DAYS - 1 - i);
    const row = byDay.get(d);
    const cap = Number(row?.cap_amount_micros ?? 0);
    return { day: d, ratio: cap > 0 ? Number(row?.used_amount_micros ?? 0) / cap : 0 };
  });
  return { days, fired: days.every((d) => d.ratio >= PRESSURE_RATIO) };
}

/** Alerts when the free report used 70% of its cap three days in a row: demand, not abuse. */
export async function checkSpendCapPressure(
  day: string,
  opts: OnAlert = {},
): Promise<SpendCapPressure> {
  const pressure = await spendCapPressure(day);
  if (pressure.fired) {
    opts.onAlert?.({
      kind: "spend-cap-pressure",
      payload: {
        scope: FREE_REPORT_SCOPE,
        days: pressure.days.map((d) => d.day).join(","),
        percents: pressure.days.map((d) => Math.round(d.ratio * 100)).join(","),
      },
    });
  }
  return pressure;
}

export interface PrimitiveLatency {
  /** Since when every daily reading was above budget; null when the last one was within it. */
  since: Date | null;
  fired: boolean;
}

/** Reads the latency trigger without probing. */
export async function primitiveLatency(): Promise<PrimitiveLatency> {
  const since = await guardModeSince(LATENCY_MODE);
  const fired = since !== null && Date.now() - since.getTime() >= (LATENCY_DAYS - 1) * DAY_MS;
  return { since, fired };
}

/**
 * Times the admission of a provider call (breaker, lease and rate bucket, all in Postgres) and
 * alerts once the p95 has stayed above 25 ms for a week of daily readings, the point where they
 * belong in Valkey.
 */
export async function checkPrimitiveLatency(
  opts: OnAlert = {},
): Promise<PrimitiveLatency & { p95Ms: number }> {
  const { acquireProviderSlot } = await probeSpendPath(LATENCY_PROBE_CALLS);
  const p95Ms = acquireProviderSlot.p95;
  if (p95Ms > LATENCY_BUDGET_MS) {
    await tripGuardMode(LATENCY_MODE, `p95 ${p95Ms} ms`, LATENCY_HOLD_MS);
  }
  const state = await primitiveLatency();
  if (state.fired && state.since) {
    opts.onAlert?.({
      kind: "primitive-latency",
      payload: { p95_ms: p95Ms, budget_ms: LATENCY_BUDGET_MS, since: state.since.toISOString() },
    });
  }
  return { p95Ms, ...state };
}

export interface ProviderVolume {
  calls: number;
  fired: boolean;
}

/** Paid provider calls of the month: every reservation that was not released, probes aside. */
export async function providerVolume(month: string): Promise<ProviderVolume> {
  if (!MONTH.test(month)) throw new InvalidInputError("Month must be YYYY-MM");
  const { rows } = await system((tx) =>
    tx.execute<{ calls: number }>(
      sql`select count(*)::int as calls from ops.spend_ledger
           where day >= ${`${month}-01`}::date
             and day < (${`${month}-01`}::date + interval '1 month')
             and status <> 'released' and ref_type <> 'latency-probe'`,
    ),
  );
  const calls = rows[0]?.calls ?? 0;
  return { calls, fired: calls > PROVIDER_CALLS_PER_MONTH };
}

/** Alerts past 2 million provider calls in a month, the volume where Temporal pays off. */
export async function checkProviderVolume(
  month: string,
  opts: OnAlert = {},
): Promise<ProviderVolume> {
  const volume = await providerVolume(month);
  if (volume.fired) {
    opts.onAlert?.({
      kind: "provider-volume",
      payload: { month, calls: volume.calls, threshold: PROVIDER_CALLS_PER_MONTH },
    });
  }
  return volume;
}
