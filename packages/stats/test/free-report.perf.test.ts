import { performance } from "node:perf_hooks";
import { trace } from "@opentelemetry/api";
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  TracerProvider,
} from "@opentelemetry/sdk-trace";
import { expect, test } from "vitest";
import type { CitedSource } from "../src/citations";
import { type CaptureFrame, type EntityColumn, pairedCompare, rankWithTies } from "../src/compare";
import { seedFor } from "../src/methodology";
import { computeFreeReportStats, type FreeReportInput } from "../src/report";
import { type EntityObservation, estimateScore } from "../src/score";
import { runFreeReportStats } from "../src/telemetry";
import { fixture, mention, TARGET } from "./fixtures/report-200";

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

// The full step on a realistic report: 200 answers naming 100 distinct businesses, from a few
// leaders recommended across engines to a long tail named once, at mixed ranks. Each answer
// cites about ten pages from 80 sites, platforms among them, behind Google redirects in a
// third of the answers, and lists a few more it did not cite.
const ENTITIES = 100;
const SITES = 80;
const PLATFORM_PAGES = ["https://www.doctoralia.co/x", "https://www.google.com/maps/place/x"];
const sourcesOf = (slot: number): CitedSource[] =>
  Array.from({ length: 14 }, (_, k) => {
    const page =
      k < 2
        ? (PLATFORM_PAGES[k] as string)
        : `https://www.site${(slot * 13 + k * 7) % SITES}.com.co/p${k}`;
    return slot % 3 === 1 && k < 10
      ? {
          url: `https://vertexaisearch.cloud.google.com/grounding-api-redirect/${slot}-${k}`,
          resolvedUrl: page,
          cited: true,
        }
      : { url: page, cited: k < 10 };
  });
const named = (slot: number) =>
  Array.from({ length: ENTITIES }, (_, j) => j).filter((j) => (slot + j * 7) % (j + 3) === 0);
const report200: FreeReportInput = {
  reportId: "fr_perf",
  asOf: new Date("2026-11-19T15:00:00.000Z"),
  target: {
    entityKey: TARGET,
    displayName: "Clínica Sonrisas",
    entityKind: "business",
    domains: ["site7.com.co"],
  },
  ...fixture({
    sources: sourcesOf,
    mentions: (slot) => [
      ...(slot % 3 === 0 ? [mention({ entityKey: TARGET, ordinal: 1 + (slot % 4) })] : []),
      ...named(slot).map((j, rank) =>
        mention({ entityKey: `place:e${j}`, ordinal: rank % 3 === 2 ? null : rank + 2 }),
      ),
    ],
  }),
};

test("computeFreeReportStats, 200 answers and 100 entities: p50 ≤ 300 ms, p95 ≤ 1 s, ≤ 64 MB", () => {
  const distinct = new Set(
    report200.extractions.flatMap((e) => e.mentions.map((m) => m.entityKey)),
  );
  expect(distinct.size).toBeGreaterThanOrEqual(ENTITIES);
  computeFreeReportStats(report200);
  const heapBefore = process.memoryUsage().heapUsed;
  const samples = Array.from({ length: RUNS }, () => {
    const start = performance.now();
    computeFreeReportStats(report200);
    return performance.now() - start;
  });
  const p50 = percentile(samples, 50);
  const p95 = percentile(samples, 95);
  console.info(`computeFreeReportStats p50 ${p50.toFixed(1)} ms, p95 ${p95.toFixed(1)} ms`);
  expect(p50).toBeLessThanOrEqual(300);
  expect(p95).toBeLessThanOrEqual(1000);
  expect(process.memoryUsage().heapUsed - heapBefore).toBeLessThanOrEqual(64 * 1024 * 1024);
}, 120_000);

// Under 10x load each report runs its own step and Fluid compute may share an instance between
// them: ten reports back to back must not get slower nor keep memory.
test("10x: ten reports back to back keep p95 ≤ 1 s each and memory flat", () => {
  computeFreeReportStats(report200);
  const heapBefore = process.memoryUsage().heapUsed;
  const samples = Array.from({ length: 10 }, (_, k) => {
    const start = performance.now();
    computeFreeReportStats({ ...report200, reportId: `fr_perf_${k}` });
    return performance.now() - start;
  });
  expect(percentile(samples, 95)).toBeLessThanOrEqual(1000);
  expect(process.memoryUsage().heapUsed - heapBefore).toBeLessThanOrEqual(64 * 1024 * 1024);
}, 120_000);

// The step the report runs: the same computation inside its span, with its event and the Wilson
// check, against a recording tracer so the span's own cost is measured too.
test("runFreeReportStats end to end, 200 answers and 100 entities: p50 ≤ 300 ms, p95 ≤ 1 s", async () => {
  const exporter = new InMemorySpanExporter();
  const provider = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] });
  trace.setGlobalTracerProvider(provider);
  try {
    runFreeReportStats(report200);
    const samples = Array.from({ length: RUNS }, () => {
      const start = performance.now();
      runFreeReportStats(report200);
      return performance.now() - start;
    });
    const p50 = percentile(samples, 50);
    const p95 = percentile(samples, 95);
    console.info(`runFreeReportStats p50 ${p50.toFixed(1)} ms, p95 ${p95.toFixed(1)} ms`);
    expect(exporter.getFinishedSpans()).toHaveLength(RUNS + 1);
    expect(p50).toBeLessThanOrEqual(300);
    expect(p95).toBeLessThanOrEqual(1000);
  } finally {
    await provider.shutdown();
    trace.disable();
  }
}, 120_000);
