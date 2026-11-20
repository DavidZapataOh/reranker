import { performance } from "node:perf_hooks";
import type { EngineId } from "@reranker/schema";
import { expect, test } from "vitest";
import { getGeo } from "../src/geo/resolve";
import { planMeasurement } from "../src/sample";
import { dentalSet } from "./fixtures/intent-set";

const RUNS = 1_000;
const WARMUP = 50;
const ENGINES: readonly EngineId[] = [
  "chatgpt",
  "gemini",
  "google-ai-overview",
  "google-ai-mode",
  "perplexity",
];

function percentile(samples: readonly number[], p: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.ceil((sorted.length * p) / 100) - 1] ?? Number.NaN;
}

test(`planMeasurement p99 under 5 ms over ${RUNS} plans`, () => {
  const intentSet = dentalSet();
  const geo = getGeo("co-c1003659");
  const plan = (reportId: string) =>
    planMeasurement({
      intentSet,
      geo,
      scope: "local",
      neighborhood: "Chapinero",
      noun: "clínica odontológica",
      engines: ENGINES,
      reportId,
    });
  for (let i = 0; i < WARMUP; i++) plan(`warmup-${i}`);
  const samples = Array.from({ length: RUNS }, (_, i) => {
    const start = performance.now();
    plan(`report-${i}`);
    return performance.now() - start;
  });
  expect(percentile(samples, 99)).toBeLessThan(5);
});
