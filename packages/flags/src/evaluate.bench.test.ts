import { expect, test, vi } from "vitest";
import { definitions, serveDefinitions } from "../test/definitions";
import { setupFlagsTests } from "../test/lifecycle";
import { getFlagsClient } from "./client";
import { FLAG_KEYS } from "./flag-keys.gen";

vi.mock("@reranker/telemetry", () => ({ sendOpsAlert: vi.fn(async () => {}) }));

const { isEnabled } = await import("./evaluate");

setupFlagsTests();

test("isEnabled p95 stays under 1 ms over 10,000 calls with definitions loaded", async () => {
  serveDefinitions(definitions(Object.fromEntries(FLAG_KEYS.map((key) => [key, true]))));
  expect(await getFlagsClient().waitForLocalEvaluationReady(3_000)).toBe(true);
  // 50 tenants × every flag; the first pass is the warm-up a long-lived instance has already done.
  const call = (i: number) =>
    isEnabled(FLAG_KEYS[i % FLAG_KEYS.length] ?? "accounts", {
      kind: "tenant",
      tenantId: `tenant-${i % 50}`,
      plan: "pro",
    });
  for (let i = 0; i < 50 * FLAG_KEYS.length; i++) await call(i);
  const samples = new Float64Array(10_000);
  for (let i = 0; i < samples.length; i++) {
    const started = performance.now();
    await call(i);
    samples[i] = performance.now() - started;
  }
  samples.sort();
  const p95 = samples[Math.floor(samples.length * 0.95)] ?? Number.POSITIVE_INFINITY;
  expect(p95, `p95 ${p95.toFixed(3)} ms`).toBeLessThan(1);
});
