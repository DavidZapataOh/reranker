import { cost } from "@reranker/schema";
import { beforeEach, expect, test, vi } from "vitest";
import { FatalError } from "workflow";

// Without the workflow compiler a step is a plain function, so each one runs here directly
// against doubles of the package functions it wraps.
const jobs = vi.hoisted(() => ({
  cleanupLeases: vi.fn(),
  refreshNetworkRanges: vi.fn(),
  refreshVelocityBaselines: vi.fn(),
  reconcileSpend: vi.fn(),
  checkWorkflowQuota: vi.fn(),
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

const { InvalidInputError } = await import("@reranker/jobs");
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

test("the workflow quota is checked for the run's month and its alert is sent", async () => {
  const alert = {
    kind: "jobs-hobby-quota",
    payload: { month: "2026-11", estimated_events: 36_000, limit: 50_000, percent: 72 },
  };
  jobs.checkWorkflowQuota.mockImplementation(async (_month, { onAlert }) => {
    onAlert(alert);
    return { estimatedEvents: 36_000, ratio: 0.72 };
  });
  await step("checkWorkflowQuota")("2026-11-17");
  expect(jobs.checkWorkflowQuota).toHaveBeenCalledWith("2026-11", expect.anything());
  expect(telemetry.sendOpsAlert).toHaveBeenCalledExactlyOnceWith("jobs-hobby-quota", alert.payload);
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
