import { requireEnv } from "@reranker/testing/env";
import { beforeAll, expect, test, vi } from "vitest";
import { dataforseoBalance } from "./dataforseo-balance";

beforeAll(() => {
  // The env helpers read APP_ENV, which the contract job does not set.
  vi.stubEnv("APP_ENV", process.env.APP_ENV || "development");
});

// user_data is free (https://docs.dataforseo.com/v3/appendix/user_data/).
test("dataforseoBalance reads a numeric balance from the live API", async () => {
  requireEnv("DATAFORSEO_LOGIN");
  requireEnv("DATAFORSEO_PASSWORD");
  const { balanceUsd } = await dataforseoBalance();
  expect(Number.isFinite(balanceUsd)).toBe(true);
  expect(balanceUsd).toBeGreaterThanOrEqual(0);
});
