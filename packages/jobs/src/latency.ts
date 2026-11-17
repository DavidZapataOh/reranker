import { randomUUID } from "node:crypto";
import { cost } from "@reranker/schema";
import { loadJobsConfig } from "./config";
import { InvalidInputError } from "./errors";
import { acquireProviderSlot } from "./leases";
import { reserveSpend, settleSpend } from "./spend";

/** Percentiles in milliseconds over `n` calls. */
export interface LatencyStats {
  p50: number;
  p95: number;
  n: number;
}

export interface SpendPathLatency {
  acquireProviderSlot: LatencyStats;
  reserveSpend: LatencyStats;
  settleSpend: LatencyStats;
}

export interface ProbeOptions {
  /** How long each call keeps its slot, standing in for the provider call. */
  holdMs?: number;
}

export const MAX_PROBE_CALLS = 1000;
const MAX_HOLD_MS = 2000;
// A lease pool and rate bucket of their own, so probing never takes a slot from real calls.
const PROBE_ACCOUNT = "latency-probe";

const percentile = (sorted: number[], p: number) =>
  sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0;
const round = (ms: number) => Math.round(ms * 100) / 100;

/** Nearest-rank p50 and p95 of samples in milliseconds. */
export function summarize(samples: readonly number[]): LatencyStats {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    p50: round(percentile(sorted, 50)),
    p95: round(percentile(sorted, 95)),
    n: sorted.length,
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function timed<T>(samples: number[], fn: () => Promise<T>): Promise<T> {
  const startedAt = performance.now();
  const result = await fn();
  samples.push(performance.now() - startedAt);
  return result;
}

/**
 * Runs the admission path of one provider call `n` times in a row and times each primitive: a
 * DataForSEO slot (breaker, lease and rate bucket), a contract-test reservation of one
 * micro-dollar (the smallest a reservation can be) and its settle at zero, so nothing is spent.
 * A denial ends the probe with its typed error.
 */
export async function probeSpendPath(
  n: number,
  opts: ProbeOptions = {},
): Promise<SpendPathLatency> {
  const holdMs = opts.holdMs ?? 0;
  if (!Number.isInteger(n) || n < 1 || n > MAX_PROBE_CALLS) {
    throw new InvalidInputError(`A probe makes 1 to ${MAX_PROBE_CALLS} calls`);
  }
  if (!Number.isInteger(holdMs) || holdMs < 0 || holdMs > MAX_HOLD_MS) {
    throw new InvalidInputError(`A probe holds its slot 0 to ${MAX_HOLD_MS} ms`);
  }
  const limits = { ...loadJobsConfig().limits.dataforseo, account: PROBE_ACCOUNT };
  const samples = { acquire: [] as number[], reserve: [] as number[], settle: [] as number[] };

  for (let i = 0; i < n; i++) {
    const slot = await timed(samples.acquire, () => acquireProviderSlot("dataforseo", limits));
    try {
      const reservation = await timed(samples.reserve, () =>
        reserveSpend({
          provider: "dataforseo",
          purpose: "contract-test",
          refType: "latency-probe",
          refId: randomUUID(),
          estimate: cost(1, "USD"),
        }),
      );
      if (holdMs > 0) await sleep(holdMs);
      await timed(samples.settle, () => settleSpend(reservation, cost(0, "USD")));
    } finally {
      await slot.release();
    }
  }

  return {
    acquireProviderSlot: summarize(samples.acquire),
    reserveSpend: summarize(samples.reserve),
    settleSpend: summarize(samples.settle),
  };
}
