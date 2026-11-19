import type { EngineId } from "@reranker/schema";
import { expect, test, vi } from "vitest";
import { systemPool } from "../../db/src/client";
import { captureSlots } from "../src/capture";
import { frozen, installCaptureHarness, ledger, provider, rowsOf } from "./support/capture-harness";

vi.mock("../../evidence/src/signer", () => ({ loadSigner: vi.fn() }));
vi.mock("@reranker/jobs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@reranker/jobs")>()),
  enqueue: vi.fn(async () => ({ jobId: "evidence.integrate:test", created: true })),
}));
vi.mock("@reranker/flags", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@reranker/flags")>()),
  assertCaptureAllowed: vi.fn(async () => undefined),
}));

// A report function runs with the pools every deployed instance has: three system connections,
// each waited for at most two seconds.
installCaptureHarness({ deployedPools: true });

// About what one R2 write round takes from iad1, so a connection held across one shows.
const R2_WRITE_MS = 250;
const CYCLE: EngineId[] = ["gemini", "google-ai-overview", "google-ai-mode"];
const cycle = (n: number) => Array.from({ length: n }, (_, i) => CYCLE[i % 3] as EngineId);

/** How long each system connection checked out from now on is held, in milliseconds. */
function recordHolds(pool: ReturnType<typeof systemPool>): { holds: number[]; stop: () => void } {
  const holds: number[] = [];
  const since = new Map<object, number>();
  const acquire = (client: object) => since.set(client, performance.now());
  const release = (_: Error | undefined, client: object) => {
    const start = since.get(client);
    if (start !== undefined) holds.push(performance.now() - start);
    since.delete(client);
  };
  pool.on("acquire", acquire);
  pool.on("release", release);
  return {
    holds,
    stop: () => {
      pool.off("acquire", acquire);
      pool.off("release", release);
    },
  };
}

const percentile = (sorted: number[], p: number) =>
  sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? Number.NaN;

test("10× load on three system connections: no checkout times out and none is held across R2", async () => {
  provider.delayMs = 20;
  provider.r2WriteMs = R2_WRITE_MS;
  const reports = await Promise.all([0, 1, 2].map(() => frozen(cycle(200))));
  const deadlineAt = Date.now() + 85_000;
  const pool = systemPool();
  const { holds, stop } = recordHolds(pool);
  const startedAt = performance.now();
  const outs = await Promise.all(
    reports.map(({ m, ids }) =>
      captureSlots(m, ids, {
        mode: "live",
        spend: { purpose: "contract-test", refType: "capture-test", refId: m },
        deadlineAt,
      }),
    ),
  ).finally(stop);
  const elapsedMs = performance.now() - startedAt;

  holds.sort((a, b) => a - b);
  console.info(
    `10× capture on ${pool.options.max} system connections: ${(elapsedMs / 1000).toFixed(2)} s; ` +
      `${holds.length} checkouts held p50 ${percentile(holds, 50).toFixed(1)} ms, ` +
      `p95 ${percentile(holds, 95).toFixed(1)} ms, p99 ${percentile(holds, 99).toFixed(1)} ms, ` +
      `max ${percentile(holds, 100).toFixed(1)} ms`,
  );
  expect(pool.options.max).toBe(3);
  expect(outs.flatMap((o) => o.failed)).toEqual([]);
  expect(provider.calls).toHaveLength(600);
  // Every capture writes to R2 once; were its connection held across that, a third of all
  // checkouts would last longer than the write.
  expect(percentile(holds, 99)).toBeLessThan(R2_WRITE_MS);
  for (const { m } of reports) {
    expect(await ledger(m)).toEqual({ settled: 200 });
    expect(await rowsOf(m)).toHaveLength(200);
  }
}, 240_000);
