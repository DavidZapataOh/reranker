import { performance } from "node:perf_hooks";
import { expect, test } from "vitest";
import { type CaptureFrame, type EntityColumn, pairedCompare, rankWithTies } from "../src/compare";
import { seedFor } from "../src/methodology";
import { type EntityObservation, estimateScore } from "../src/score";

const RUNS = 30;
const CAPTURES = 200;
const STRATA = 25;

function percentile(samples: readonly number[], p: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.ceil((sorted.length * p) / 100) - 1] ?? Number.NaN;
}

// A fresh frame per run, so every run pays for its own bootstrap draws as a report would.
function frameOf(): CaptureFrame {
  return {
    captures: Array.from({ length: CAPTURES }, (_, i) => ({
      stratum: `s${Math.floor(i / (CAPTURES / STRATA))}`,
      weight: 1 / STRATA,
    })),
  };
}

// Recommendations spread across strata at mixed ranks, from a leader to a long tail.
function entity(key: string, recommended: number, offset: number) {
  const y = new Uint8Array(CAPTURES);
  const ordinal = new Int16Array(CAPTURES);
  for (let r = 0; r < recommended; r++) {
    const i = (offset + r * 7) % CAPTURES;
    y[i] = 1;
    ordinal[i] = 1 + (r % 5);
  }
  const frame = frameOf();
  const obs: EntityObservation[] = frame.captures.map(({ stratum, weight }, captureIndex) => ({
    captureIndex,
    stratum,
    weight,
    y: y[captureIndex] === 1 ? 1 : 0,
    ordinal: y[captureIndex] === 1 ? (ordinal[captureIndex] as number) : null,
    isCanonical: false,
  }));
  const column: EntityColumn = { key, y, ordinal };
  return { key, obs, column };
}

const entities = [80, 60, 50, 40, 30, 20, 15, 10, 6, 3, 1].map((n, k) => entity(`e${k}`, n, k * 3));

function freeReport(run: number): void {
  const frame = frameOf();
  const reportSeed = seedFor("report", String(run));
  const bootstrap = { frame, seed: reportSeed };
  const scores = entities.map((e) => ({
    e,
    score: estimateScore(e.obs, seedFor("report", String(run), e.key), { bootstrap }),
  }));
  const [target, ...rest] = scores;
  const competitors = rest.slice(0, 5);
  for (const c of competitors) {
    pairedCompare((target as (typeof scores)[number]).e.column, c.e.column, frame, reportSeed);
  }
  rankWithTies(
    [target, ...competitors].map((s) => {
      const { e, score } = s as (typeof scores)[number];
      return { column: e.column, value: score.value, pointValue: score.value };
    }),
    frame,
    reportSeed,
  );
}

// The free report's statistics step: 11 score ranges, the target against its top 5 and their
// ranking, on one shared bootstrap. Raw samples, because `vitest bench` cannot fail on a threshold.
test("free report scores, comparisons and ranking: p50 ≤ 150 ms, p95 ≤ 300 ms", () => {
  freeReport(-1);
  const samples = Array.from({ length: RUNS }, (_, run) => {
    const start = performance.now();
    freeReport(run);
    return performance.now() - start;
  });
  const p50 = percentile(samples, 50);
  const p95 = percentile(samples, 95);
  console.info(`free report stats p50 ${p50.toFixed(1)} ms, p95 ${p95.toFixed(1)} ms`);
  expect(p50).toBeLessThanOrEqual(150);
  expect(p95).toBeLessThanOrEqual(300);
}, 60_000);
