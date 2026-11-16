import { execFileSync } from "node:child_process";
import { expect, test } from "vitest";
import { NeonUsageSchema } from "./neon-usage";

// Runs against the reranker-nonprod project with the nightly's restricted key; a missing
// variable fails the test rather than skipping it.
test("db:usage against reranker-nonprod returns JSON valid against NeonUsageSchema", () => {
  const projectId = process.env.NEON_PROJECT_ID;
  expect(projectId, "NEON_PROJECT_ID").toBeTruthy();
  expect(process.env.NEON_API_KEY, "NEON_API_KEY").toBeTruthy();
  const out = JSON.parse(execFileSync("pnpm", ["--silent", "db:usage"], { encoding: "utf8" }));
  const usage = NeonUsageSchema.parse(out);
  expect(usage.projects[0]?.projectId).toBe(projectId);
});
