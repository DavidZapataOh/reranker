import { randomUUID } from "node:crypto";
import { listWorkflowRefs } from "@workflow/vitest";
import { expect, test } from "vitest";
import { start } from "workflow/api";
import { pingWorkflow } from "@/workflows/diagnostics/ping";
import { DAILY_STEPS } from "@/workflows/maintenance/daily";
import { batchResumeWorkflow, dailyStepsWorkflow, retryTimingWorkflow } from "./workflows/fixtures";
import { attemptsOf, callCount, entriesOf } from "./workflows/ledger";

const unique = () => `run-${randomUUID()}`;

test("pingWorkflow runs three steps on the local world", async () => {
  const run = await start(pingWorkflow, ["n-1"]);
  expect(run.runId).toMatch(/^wrun_/);
  await expect(run.returnValue).resolves.toEqual({ steps: 3, dbOk: true });
  expect(await run.status).toBe("completed");
});

test("fixtures are compiled by the test build", () =>
  expect(listWorkflowRefs().map((ref) => ref.name)).toEqual(
    expect.arrayContaining([
      "retryTimingWorkflow",
      "batchResumeWorkflow",
      "dailyStepsWorkflow",
      "dailyMaintenanceWorkflow",
    ]),
  ));

test("a batch retry calls only the pending items", async () => {
  const runKey = unique();
  const run = await start(batchResumeWorkflow, [runKey]);
  await run.returnValue;
  expect(await callCount(runKey)).toBe(13);
});

test("RateLimited(7000) retries after 7 s ± 1 s", async () => {
  const runKey = unique();
  const run = await start(retryTimingWorkflow, [runKey, "rate"]);
  const { gapMs } = await run.returnValue;
  expect(gapMs).toBeGreaterThanOrEqual(6000);
  expect(gapMs).toBeLessThanOrEqual(8000);
});

test("SpendCapExceeded is not retried", async () => {
  const runKey = unique();
  const run = await start(retryTimingWorkflow, [runKey, "cap"]);
  await expect(run.returnValue).rejects.toThrow(/SpendCapExceeded/);
  expect(await attemptsOf(runKey)).toBe(1);
});

test("DAILY_STEPS keep the spec order", () => {
  const order = [
    "cleanupLeases",
    "refreshNetworkRanges",
    "velocityBaseline",
    "purgeExpiredAuthRecords",
    "reconcileSpend",
    "checkWorkflowBudget",
    "checkScaleTriggers",
    "otsUpgrade",
    "controlCanary",
    "prewarmIntentSets",
    "qualityCanary",
    "drainDeferredFreeReports",
    "enqueueDueRemeasures",
    "leadRetentionSweep",
    "launchGate",
    "opsDigest",
  ];
  const names = DAILY_STEPS.map((s) => s.name);
  expect(names).toEqual(order.filter((n) => names.includes(n)));
  expect(names).toEqual(
    expect.arrayContaining([
      "cleanupLeases",
      "refreshNetworkRanges",
      "velocityBaseline",
      "reconcileSpend",
      "checkWorkflowBudget",
      "checkScaleTriggers",
      "launchGate",
    ]),
  );
});

const ranSteps = async (runKey: string) =>
  (await entriesOf(runKey, "ran")).map((entry) => entry.item);

test("a failing step does not stop the next ones", async () => {
  const runKey = unique();
  const run = await start(dailyStepsWorkflow, [runKey, false]);
  await expect(run.returnValue).resolves.toEqual({ failed: ["broken"] });
  expect(await ranSteps(runKey)).toEqual(["first", "broken", "last"]);
});

test("a failing critical step stops the run", async () => {
  const runKey = unique();
  const run = await start(dailyStepsWorkflow, [runKey, true]);
  await expect(run.returnValue).rejects.toThrow(/broken on purpose/);
  expect(await ranSteps(runKey)).toEqual(["first", "broken"]);
});
