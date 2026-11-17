import { EnvValidationError } from "@reranker/env";
import { expect, test } from "vitest";
import { loadJobsConfig } from "../src/config";

test("production defaults match the spend caps", () => {
  const c = loadJobsConfig({ APP_ENV: "production" });
  expect(c.caps.global.amount_micros).toBe(75_000_000);
  expect(c.caps["provider:dataforseo"].amount_micros).toBe(36_000_000);
  expect(c.caps["provider:brightdata"].amount_micros).toBe(5_000_000);
  expect(c.caps["provider:openai"].amount_micros).toBe(14_000_000);
  expect(c.caps["provider:gemini"].amount_micros).toBe(11_000_000);
  expect(c.caps["provider:google_places"].amount_micros).toBe(18_000_000);
  expect(c.caps["provider:anthropic"].amount_micros).toBe(5_000_000);
  expect(c.caps["provider:xai"].amount_micros).toBe(5_000_000);
  expect(c.caps["purpose:free-report"].amount_micros).toBe(50_000_000);
  expect(c.caps["pool:free-report-anonymous"].amount_micros).toBe(30_000_000);
  expect(c.caps["pool:free-report-verified"].amount_micros).toBe(20_000_000);
  expect(c.caps["pool:free-report-elsewhere"].amount_micros).toBe(20_000_000);
  expect(c.caps["purpose:control-canary"].amount_micros).toBe(1_000_000);
  expect(c.caps["purpose:benchmark"].amount_micros).toBe(20_000_000);
  expect(c.caps["purpose:contract-test"].amount_micros).toBe(500_000);
  expect(c.caps["purpose:quality-canary"].amount_micros).toBe(3_000_000);
  expect(c.quotas["resend.emails"]).toEqual({
    daily: 100,
    split: { critical: 30, high: 16, normal: 50, low: 4 },
  });
  expect(c.limits.dataforseo).toMatchObject({ maxInFlight: 28, rpm: 9000 });
  expect(c.limits.brightdata.maxInFlight).toBe(100);
  expect(c.limits.openai.maxInFlight).toBe(10);
  expect(c.limits.openai).not.toHaveProperty("rpm");
  expect(c.maxInlineWaitMs).toBe(5000);
  expect(c.breaker).toEqual({ minCalls: 20, failureRatio: 0.5, openMs: 30_000 });
});

test.each(["preview", "development"])(
  "%s caps real providers at zero except contract tests",
  (APP_ENV) => {
    const c = loadJobsConfig({ APP_ENV });
    for (const provider of Object.keys(c.limits)) {
      expect(c.caps[`provider:${provider as keyof typeof c.limits}`].amount_micros).toBe(0);
    }
    expect(c.caps["purpose:contract-test"].amount_micros).toBe(500_000);
  },
);

test("variables override the defaults", () => {
  const c = loadJobsConfig({
    APP_ENV: "production",
    SPEND_CAP_DAILY_ANTHROPIC_USD: "30",
    SPEND_CAP_DAILY_CONTRACT_TEST_USD: "0.25",
    OPENAI_RPM: "500",
    OPENAI_TPM: "200000",
    GOOGLE_PLACES_QPM: "600",
    BREAKER_FAILURE_RATIO: "0.4",
    JOBS_MAX_INLINE_WAIT_MS: "3000",
    QUOTA_RESEND_EMAILS_DAILY: "50",
    QUOTA_RESEND_EMAILS_SPLIT: "10/10/20/10",
  });
  expect(c.caps["provider:anthropic"].amount_micros).toBe(30_000_000);
  expect(c.caps["purpose:contract-test"].amount_micros).toBe(250_000);
  expect(c.limits.openai).toMatchObject({ rpm: 500, tpm: 200_000 });
  expect(c.limits.google_places.rpm).toBe(600);
  expect(c.breaker.failureRatio).toBe(0.4);
  expect(c.maxInlineWaitMs).toBe(3000);
  expect(c.quotas["resend.emails"].split).toEqual({ critical: 10, high: 10, normal: 20, low: 10 });
});

test("empty values count as unset", () => {
  const c = loadJobsConfig({ APP_ENV: "production", SPEND_CAP_DAILY_GLOBAL_USD: "" });
  expect(c.caps.global.amount_micros).toBe(75_000_000);
});

test("pools must add up to the free-report cap", () => {
  expect(() =>
    loadJobsConfig({ APP_ENV: "production", SPEND_CAP_DAILY_FREE_REPORT_ANONYMOUS_USD: "40" }),
  ).toThrow(/pool/);
});

test("the elsewhere pool lives inside the free-report cap", () => {
  expect(() =>
    loadJobsConfig({ APP_ENV: "production", SPEND_CAP_DAILY_FREE_REPORT_ELSEWHERE_USD: "51" }),
  ).toThrow(/elsewhere/);
});

test("split must add up to the daily quota", () => {
  expect(() =>
    loadJobsConfig({ APP_ENV: "production", QUOTA_RESEND_EMAILS_SPLIT: "30/16/50/5" }),
  ).toThrow(/split/);
});

test("invalid values name the variable and never echo it", () => {
  const read = () => loadJobsConfig({ APP_ENV: "production", SPEND_CAP_DAILY_GLOBAL_USD: "lots" });
  expect(read).toThrow(EnvValidationError);
  expect(read).toThrow(/SPEND_CAP_DAILY_GLOBAL_USD/);
  expect(read).not.toThrow(/lots/);
});

test("APP_ENV is required", () => {
  expect(() => loadJobsConfig({})).toThrow(/APP_ENV/);
});

test("the process configuration is read once", () => {
  const previous = process.env.APP_ENV;
  process.env.APP_ENV = "production";
  try {
    expect(loadJobsConfig()).toBe(loadJobsConfig());
  } finally {
    if (previous === undefined) delete process.env.APP_ENV;
    else process.env.APP_ENV = previous;
  }
});

test("the monthly Vercel Workflows budget is US$10 unless configured", () => {
  expect(loadJobsConfig({ APP_ENV: "production" }).budgets.workflowsMonthlyUsd).toBe(10);
  expect(
    loadJobsConfig({ APP_ENV: "production", WORKFLOWS_MONTHLY_BUDGET_USD: "25.5" }).budgets
      .workflowsMonthlyUsd,
  ).toBe(25.5);
  expect(() =>
    loadJobsConfig({ APP_ENV: "production", WORKFLOWS_MONTHLY_BUDGET_USD: "diez" }),
  ).toThrow(EnvValidationError);
});
