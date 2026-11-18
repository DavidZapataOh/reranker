import { execFileSync } from "node:child_process";
import { requireEnv } from "@reranker/testing/env";
import { expect, test } from "vitest";
import { NeonUsageSchema } from "./neon-usage";

// The consumption endpoint is organization-wide, so this needs an organization key like the one
// production reads with; a project-scoped key gets a 404 there.
test("db:usage against reranker-nonprod returns JSON valid against NeonUsageSchema", () => {
  const projectId = requireEnv("NEON_PROJECT_ID");
  requireEnv("NEON_API_KEY");
  const out = JSON.parse(execFileSync("pnpm", ["--silent", "db:usage"], { encoding: "utf8" }));
  const usage = NeonUsageSchema.parse(out);
  expect(usage.projects[0]?.projectId).toBe(projectId);
});
