import { requireEnv } from "@reranker/testing/env";
import { beforeAll, expect, test, vi } from "vitest";
import { posthogUsage } from "./posthog-usage";

beforeAll(() => {
  // The env helpers read APP_ENV, which the contract job does not set.
  vi.stubEnv("APP_ENV", process.env.APP_ENV || "development");
});

// Needs a personal API key with Query Read on the project.
test("posthogUsage counts this month's events and exceptions", async () => {
  requireEnv("POSTHOG_QUERY_READ_KEY");
  const { events, exceptions } = await posthogUsage();
  expect(Number.isInteger(events)).toBe(true);
  expect(Number.isInteger(exceptions)).toBe(true);
});
