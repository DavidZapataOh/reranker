import { cost } from "@reranker/schema";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { FatalError, RetryableError } from "workflow";

// Without the workflow compiler a step is a plain function, so each one runs here directly
// against doubles of the package functions it wraps.
const jobs = vi.hoisted(() => ({
  cleanupLeases: vi.fn(),
  refreshNetworkRanges: vi.fn(),
  refreshVelocityBaselines: vi.fn(),
  reconcileSpend: vi.fn(),
  checkWorkflowBudget: vi.fn(),
  checkSpendCapPressure: vi.fn(),
  checkPrimitiveLatency: vi.fn(),
  checkProviderVolume: vi.fn(),
  reportStepError: vi.fn(async () => {}),
}));
vi.mock("@reranker/jobs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@reranker/jobs")>()),
  ...jobs,
}));
const telemetry = vi.hoisted(() => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  sendOpsAlert: vi.fn(async () => {}),
}));
vi.mock("@reranker/telemetry", () => telemetry);
vi.mock("workflow", async (importOriginal) => ({
  ...(await importOriginal<typeof import("workflow")>()),
  getStepMetadata: () => ({ attempt: 3 }),
}));
const authPurge = vi.hoisted(() => ({ purgeExpiredAuthRecords: vi.fn() }));
vi.mock("@reranker/auth/purge", () => authPurge);
const extraction = vi.hoisted(() => ({ refreshStalePlaceIds: vi.fn() }));
vi.mock("@reranker/extraction", () => extraction);

const { InvalidInputError, RateLimitedError } = await import("@reranker/jobs");
const { DAILY_STEPS } = await import("./daily");

const step = (name: string) => {
  const found = DAILY_STEPS.find((s) => s.name === name);
  if (!found) throw new Error(`no daily step ${name}`);
  return found.run;
};
const usd = (micros: number) => cost(micros, "USD");
const stale = { kind: "network-ranges-stale", payload: { reason: "download_failed", hours: 49 } };

beforeEach(() => {
  vi.clearAllMocks();
});

test("cleanup logs what it removed", async () => {
  jobs.cleanupLeases.mockResolvedValue({ leases: 1, buckets: 2, velocity: 3, breakerWindows: 4 });
  await step("cleanupLeases")("2026-11-17");
  expect(telemetry.log.info).toHaveBeenCalledWith("jobs.daily.cleanup", {
    leases: 1,
    buckets: 2,
    velocity: 3,
    breakerWindows: 4,
  });
});

test("a stale network list alerts even when the refresh then fails, and the step retries", async () => {
  const outage = new Error("raw.githubusercontent.com answered 503");
  jobs.refreshNetworkRanges.mockImplementation(async (_fetch, { onAlert }) => {
    onAlert(stale);
    throw outage;
  });
  await expect(step("refreshNetworkRanges")("2026-11-17")).rejects.toBe(outage);
  expect(telemetry.sendOpsAlert).toHaveBeenCalledExactlyOnceWith(
    "network-ranges-stale",
    stale.payload,
  );
});

test("a throttled refresh knows its attempt and retries after the wait GitHub asked for", async () => {
  jobs.refreshNetworkRanges.mockRejectedValue(new RateLimitedError(240_000, "github.com"));
  const now = Date.now();
  const error = await step("refreshNetworkRanges")("2026-11-17").catch((e: unknown) => e);
  expect(jobs.refreshNetworkRanges).toHaveBeenCalledWith(
    fetch,
    expect.objectContaining({ attempt: 3 }),
  );
  expect(RetryableError.is(error)).toBe(true);
  expect((error as RetryableError).retryAfter.getTime() - now).toBeGreaterThanOrEqual(239_000);
  expect((error as Error).message).toMatch(/^RateLimited: Rate limited by github.com/);
});

test("a refused list alerts and the step completes with the old list in place", async () => {
  jobs.refreshNetworkRanges.mockImplementation(async (_fetch, { onAlert }) => {
    onAlert({ kind: "network-ranges-stale", payload: { reason: "change_too_large" } });
    return { applied: false, rows: 50_000, added: 0, removed: 0, changed: 0, commit: "abc" };
  });
  await step("refreshNetworkRanges")("2026-11-17");
  expect(telemetry.sendOpsAlert).toHaveBeenCalledExactlyOnceWith("network-ranges-stale", {
    reason: "change_too_large",
  });
  expect(telemetry.log.info).toHaveBeenCalledWith(
    "jobs.daily.network_ranges",
    expect.objectContaining({ applied: false, rows: 50_000 }),
  );
});

test("velocity baselines log how many keys were computed", async () => {
  jobs.refreshVelocityBaselines.mockResolvedValue(12);
  await step("velocityBaseline")("2026-11-17");
  expect(telemetry.log.info).toHaveBeenCalledWith("jobs.daily.velocity_baselines", { keys: 12 });
});

test("the auth purge runs after the velocity baselines and logs what it removed", async () => {
  const names = DAILY_STEPS.map((s) => s.name);
  expect(names.indexOf("purgeExpiredAuthRecords")).toBe(names.indexOf("velocityBaseline") + 1);
  authPurge.purgeExpiredAuthRecords.mockResolvedValue({
    sessions: 1,
    verifications: 2,
    rateLimits: 3,
  });
  await step("purgeExpiredAuthRecords")("2026-11-17");
  expect(telemetry.log.info).toHaveBeenCalledWith("jobs.daily.auth_purge", {
    sessions: 1,
    verifications: 2,
    rate_limits: 3,
  });
});

test("a failed auth purge is reported under its own name and retried", async () => {
  const error = new Error("canceling statement due to statement timeout");
  authPurge.purgeExpiredAuthRecords.mockRejectedValue(error);
  await expect(step("purgeExpiredAuthRecords")("2026-11-17")).rejects.toBe(error);
  expect(jobs.reportStepError).toHaveBeenCalledExactlyOnceWith(
    "daily",
    "purgeExpiredAuthRecords",
    error,
  );
});

test("the place id refresh runs after the scale triggers on 200 ids and logs its counts", async () => {
  const names = DAILY_STEPS.map((s) => s.name);
  expect(names.indexOf("refreshPlaceIds")).toBe(names.indexOf("checkScaleTriggers") + 1);
  extraction.refreshStalePlaceIds.mockResolvedValue({ checked: 200, moved: 3, gone: 1 });
  await step("refreshPlaceIds")("2026-11-17");
  expect(extraction.refreshStalePlaceIds).toHaveBeenCalledExactlyOnceWith(200, {
    purpose: "quality-canary",
    refType: "places-refresh",
    refId: "2026-11-17",
  });
  expect(telemetry.log.info).toHaveBeenCalledWith("jobs.daily.place_ids_refreshed", {
    checked: 200,
    moved: 3,
    gone: 1,
  });
});

test("a Places outage during the refresh is reported and retried", async () => {
  const error = new RateLimitedError(1000, "Places");
  extraction.refreshStalePlaceIds.mockRejectedValue(error);
  const thrown = await step("refreshPlaceIds")("2026-11-17").catch((e: unknown) => e);
  expect(RetryableError.is(thrown)).toBe(true);
  expect(jobs.reportStepError).toHaveBeenCalledExactlyOnceWith("daily", "refreshPlaceIds", error);
});

test("reconciliation closes the day that just ended and logs each mismatch as an error", async () => {
  jobs.reconcileSpend.mockResolvedValue({
    released: 2,
    mismatches: [
      { provider: "brightdata", ledger: usd(1_000_000), provider_reported: usd(1_600_000) },
    ],
  });
  await step("reconcileSpend")("2026-03-01");
  expect(jobs.reconcileSpend).toHaveBeenCalledExactlyOnceWith("2026-02-28");
  expect(telemetry.log.error).toHaveBeenCalledExactlyOnceWith("jobs.spend.mismatch", {
    day: "2026-02-28",
    provider: "brightdata",
    currency: "USD",
    ledger_micros: 1_000_000,
    provider_micros: 1_600_000,
  });
});

test("the workflow budget is checked for the run's month and its alert is sent", async () => {
  const alert = {
    kind: "jobs-workflow-budget",
    payload: { month: "2026-11", estimated_events: 360_000, spend_usd: 7.2, percent: 72 },
  };
  jobs.checkWorkflowBudget.mockImplementation(async (_month, { onAlert }) => {
    onAlert(alert);
    return { estimatedEvents: 360_000, spendUsd: 7.2, budgetUsd: 10, ratio: 0.72 };
  });
  await step("checkWorkflowBudget")("2026-11-17");
  expect(jobs.checkWorkflowBudget).toHaveBeenCalledWith("2026-11", expect.anything());
  expect(telemetry.sendOpsAlert).toHaveBeenCalledExactlyOnceWith(
    "jobs-workflow-budget",
    alert.payload,
  );
});

describe("checkScaleTriggers", () => {
  beforeEach(() => {
    jobs.checkSpendCapPressure.mockResolvedValue({ days: [], fired: false });
    jobs.checkPrimitiveLatency.mockResolvedValue({ p95Ms: 12, since: null, fired: false });
    jobs.checkProviderVolume.mockResolvedValue({ calls: 10, fired: false });
  });

  test("reads the closed day and its month, and sends every alert raised", async () => {
    const pressure = { kind: "spend-cap-pressure", payload: { percents: "70,80,90" } };
    const volume = { kind: "provider-volume", payload: { calls: 2_000_001 } };
    jobs.checkSpendCapPressure.mockImplementation(async (_day, { onAlert }) => {
      onAlert(pressure);
      return { days: [], fired: true };
    });
    jobs.checkProviderVolume.mockImplementation(async (_month, { onAlert }) => {
      onAlert(volume);
      return { calls: 2_000_001, fired: true };
    });
    await step("checkScaleTriggers")("2026-12-01");
    expect(jobs.checkSpendCapPressure).toHaveBeenCalledWith("2026-11-30", expect.anything());
    expect(jobs.checkProviderVolume).toHaveBeenCalledWith("2026-11", expect.anything());
    expect(telemetry.sendOpsAlert).toHaveBeenCalledWith("spend-cap-pressure", pressure.payload);
    expect(telemetry.sendOpsAlert).toHaveBeenCalledWith("provider-volume", volume.payload);
  });

  test("a latency probe the breaker refuses is skipped and the other triggers still run", async () => {
    jobs.checkPrimitiveLatency.mockRejectedValue(new Error("breaker open"));
    await step("checkScaleTriggers")("2026-11-17");
    expect(telemetry.log.warn).toHaveBeenCalledWith("jobs.daily.primitive_latency_skipped", {
      error: "Error",
    });
    expect(jobs.checkProviderVolume).toHaveBeenCalledOnce();
  });
});

test("a failure that retrying cannot fix ends the step without retries", async () => {
  const error = new InvalidInputError("bad currency");
  jobs.reconcileSpend.mockRejectedValue(error);
  await expect(step("reconcileSpend")("2026-11-17")).rejects.toBeInstanceOf(FatalError);
  expect(jobs.reportStepError).toHaveBeenCalledExactlyOnceWith("daily", "reconcileSpend", error);
});

test("every failed step is reported under its own name before it is rethrown", async () => {
  const error = new Error("socket hang up");
  jobs.cleanupLeases.mockRejectedValue(error);
  await expect(step("cleanupLeases")("2026-11-17")).rejects.toBe(error);
  expect(jobs.reportStepError).toHaveBeenCalledExactlyOnceWith("daily", "cleanupLeases", error);
});

test("a step that succeeds reports nothing", async () => {
  jobs.refreshVelocityBaselines.mockResolvedValue(1);
  await step("velocityBaseline")("2026-11-17");
  expect(jobs.reportStepError).not.toHaveBeenCalled();
});

test("the ops digest runs last, so it reports on every step before it", () => {
  expect(DAILY_STEPS.at(-1)?.name).toBe("opsDigest");
});

test("the Vercel billing check runs right before the launch gate", () => {
  const names = DAILY_STEPS.map((s) => s.name);
  expect(names.indexOf("vercelBilling")).toBeGreaterThan(-1);
  expect(names.indexOf("launchGate")).toBe(names.indexOf("vercelBilling") + 1);
});
