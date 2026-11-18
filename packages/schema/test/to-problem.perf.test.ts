import { performance } from "node:perf_hooks";
import { expect, test } from "vitest";
import { AppError, toProblem } from "../src/index";

const WARMUP = 1_000;
const SAMPLES = 10_000;

function percentile(samples: readonly number[], p: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.ceil((sorted.length * p) / 100) - 1] ?? Number.NaN;
}

// Every API error and failed action renders through toProblem, so it must stay far below a request's
// own cost. A percentile from raw samples, because `vitest bench` cannot fail on a threshold.
test("toProblem p95 ≤ 0.2 ms", () => {
  const error = new AppError("rate_limited", { retryAfterSeconds: 30 });
  for (let i = 0; i < WARMUP; i++) toProblem(error, { locale: "es-CO" });
  const samples = Array.from({ length: SAMPLES }, () => {
    const start = performance.now();
    toProblem(error, { locale: "es-CO" });
    return performance.now() - start;
  });
  const p95 = percentile(samples, 95);
  console.info(`toProblem p50 ${percentile(samples, 50).toFixed(4)} ms, p95 ${p95.toFixed(4)} ms`);
  expect(p95).toBeLessThanOrEqual(0.2);
});
