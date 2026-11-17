import { randomUUID } from "node:crypto";
import { listWorkflowRefs } from "@workflow/vitest";
import { expect, test } from "vitest";
import { start } from "workflow/api";
import { pingWorkflow } from "@/workflows/diagnostics/ping";
import { batchResumeWorkflow, retryTimingWorkflow } from "./workflows/fixtures";
import { attemptsOf, callCount } from "./workflows/ledger";

const unique = () => `run-${randomUUID()}`;

test("pingWorkflow runs three steps on the local world", async () => {
  const run = await start(pingWorkflow, ["n-1"]);
  expect(run.runId).toMatch(/^wrun_/);
  await expect(run.returnValue).resolves.toEqual({ steps: 3, dbOk: true });
  expect(await run.status).toBe("completed");
});

test("fixtures are compiled by the test build", () =>
  expect(listWorkflowRefs().map((ref) => ref.name)).toEqual(
    expect.arrayContaining(["retryTimingWorkflow", "batchResumeWorkflow"]),
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
