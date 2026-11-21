import { EnvValidationError } from "@reranker/env";
import { spendCapsCheck } from "@reranker/telemetry/launch";
import { expect, test } from "vitest";
import { type JobsConfig, loadJobsConfig, providerCapFloor } from "../src/config";

const micros = (c: JobsConfig, scope: keyof JobsConfig["caps"]) => c.caps[scope].amount_micros;
const spendCaps = (c: JobsConfig) => ({ caps: c.caps, floors: providerCapFloor(c) });

test("caps follow the demand they cover", () => {
  const c = loadJobsConfig({ APP_ENV: "production" });
  expect(micros(c, "purpose:free-report")).toBe(200_000_000);
  expect(micros(c, "pool:free-report-anonymous")).toBe(120_000_000);
  expect(micros(c, "pool:free-report-verified")).toBe(80_000_000);
  expect(micros(c, "pool:free-report-elsewhere")).toBe(80_000_000);
  expect(micros(c, "purpose:control-canary")).toBe(70_000_000);
  expect(micros(c, "purpose:quality-canary")).toBe(6_000_000);
  expect(micros(c, "purpose:benchmark")).toBe(40_000_000);
  expect(micros(c, "purpose:contract-test")).toBe(500_000);
  expect(micros(c, "purpose:language-mix")).toBe(10_000_000);
  expect(c.caps.global.amount_micros).toBe(320_000_000);
});

test("provider caps are what their purposes can spend plus a fifth", () => {
  const c = loadJobsConfig({ APP_ENV: "production" });
  // (200 + 70 + 6 + 40 + 0.5) × 1.2, plus the language mix's 10 × 1.2 on DataForSEO, and, for the
  // benchmark-only providers, (40 + 0.5) × 1.2.
  expect(micros(c, "provider:dataforseo")).toBe(391_800_000);
  for (const p of ["brightdata", "openai", "gemini", "google_places"] as const) {
    expect(micros(c, `provider:${p}`)).toBe(379_800_000);
  }
  expect(micros(c, "provider:anthropic")).toBe(48_600_000);
  expect(micros(c, "provider:xai")).toBe(48_600_000);
});

test("no provider cap can starve a purpose", () => {
  const c = loadJobsConfig({ APP_ENV: "production" });
  for (const [p, floor] of Object.entries(providerCapFloor(c))) {
    expect(micros(c, `provider:${p as keyof typeof c.limits}`)).toBeGreaterThanOrEqual(floor);
  }
  expect(spendCapsCheck(spendCaps(c)).status).toBe("pass");
});

test("raising a purpose cap raises the provider caps it spends on", () => {
  const c = loadJobsConfig({ APP_ENV: "production", SPEND_CAP_DAILY_BENCHMARK_USD: "100" });
  expect(micros(c, "provider:anthropic")).toBe(120_600_000);
  expect(micros(c, "provider:dataforseo")).toBe(463_800_000);
});

test("launch check fails when a provider cap could starve a purpose", () => {
  const c = loadJobsConfig({ APP_ENV: "production", SPEND_CAP_DAILY_DATAFORSEO_USD: "10" });
  expect(spendCapsCheck(spendCaps(c)).status).toBe("fail");
});

test("capacity limits follow the published provider limits", () => {
  const c = loadJobsConfig({ APP_ENV: "production" });
  expect(c.limits.dataforseo).toMatchObject({ maxInFlight: 28, rpm: 9000 });
  expect(c.limits.brightdata.maxInFlight).toBe(200);
});

test("production defaults for quotas, limits and the breaker", () => {
  const c = loadJobsConfig({ APP_ENV: "production" });
  expect(c.quotas["resend.emails"]).toEqual({ hourlyFloor: 500, peakMultiplier: 10 });
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
    QUOTA_RESEND_EMAILS_HOURLY_FLOOR: "0",
    QUOTA_RESEND_EMAILS_PEAK_MULTIPLIER: "3",
  });
  expect(c.caps["provider:anthropic"].amount_micros).toBe(30_000_000);
  expect(c.caps["purpose:contract-test"].amount_micros).toBe(250_000);
  expect(c.limits.openai).toMatchObject({ rpm: 500, tpm: 200_000 });
  expect(c.limits.google_places.rpm).toBe(600);
  expect(c.breaker.failureRatio).toBe(0.4);
  expect(c.maxInlineWaitMs).toBe(3000);
  expect(c.quotas["resend.emails"]).toEqual({ hourlyFloor: 0, peakMultiplier: 3 });
});

test("empty values count as unset", () => {
  const c = loadJobsConfig({ APP_ENV: "production", SPEND_CAP_DAILY_GLOBAL_USD: "" });
  expect(c.caps.global.amount_micros).toBe(320_000_000);
});

test("pools must add up to the free-report cap", () => {
  expect(() =>
    loadJobsConfig({ APP_ENV: "production", SPEND_CAP_DAILY_FREE_REPORT_ANONYMOUS_USD: "40" }),
  ).toThrow(/pool/);
});

test("the elsewhere pool lives inside the free-report cap", () => {
  expect(() =>
    loadJobsConfig({ APP_ENV: "production", SPEND_CAP_DAILY_FREE_REPORT_ELSEWHERE_USD: "201" }),
  ).toThrow(/elsewhere/);
});

test("a negative email brake is invalid", () => {
  expect(() =>
    loadJobsConfig({ APP_ENV: "production", QUOTA_RESEND_EMAILS_HOURLY_FLOOR: "-1" }),
  ).toThrow(/QUOTA_RESEND_EMAILS_HOURLY_FLOOR/);
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
