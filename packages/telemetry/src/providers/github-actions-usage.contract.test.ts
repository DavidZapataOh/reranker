import { requireEnv } from "@reranker/testing/env";
import { beforeAll, expect, test, vi } from "vitest";
import { githubActionsUsage } from "./github-actions-usage";

beforeAll(() => {
  // The env helpers read APP_ENV, which the contract job does not set.
  vi.stubEnv("APP_ENV", process.env.APP_ENV || "development");
});

// The billing endpoints accept only a classic token with the `user` scope.
test("githubActionsUsage reads this month's Actions usage", async () => {
  requireEnv("GITHUB_BILLING_READ_TOKEN");
  const usage = await githubActionsUsage(new Date().toISOString().slice(0, 7));
  expect(usage.minutesUsed).toBeGreaterThanOrEqual(0);
  expect(usage.includedUsedUsd).toBeGreaterThanOrEqual(0);
  expect(usage.includedUsd).toBe(12);
});
