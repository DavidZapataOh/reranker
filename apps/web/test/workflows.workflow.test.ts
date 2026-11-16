import { expect, test } from "vitest";
import { start } from "workflow/api";
import { pingWorkflow } from "@/workflows/diagnostics/ping";

test("pingWorkflow runs three steps on the local world", async () => {
  const run = await start(pingWorkflow, ["n-1"]);
  expect(run.runId).toMatch(/^wrun_/);
  await expect(run.returnValue).resolves.toEqual({ steps: 3, dbOk: true });
  expect(await run.status).toBe("completed");
});
