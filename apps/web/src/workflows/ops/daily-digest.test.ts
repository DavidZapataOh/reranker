import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { FatalError } from "workflow";

// Doubles of every source and side effect; the digest's own assembly (fetchWithin and
// buildDailyDigest) is the real one.
const sources = vi.hoisted(() => ({
  dataforseoBalance: vi.fn(),
  githubActionsUsage: vi.fn(),
  posthogUsage: vi.fn(),
  pingHeartbeat: vi.fn(async () => {}),
  sendDailyDigest: vi.fn(async () => true),
  digestEmailConfigured: vi.fn(() => true),
}));
vi.mock("@reranker/telemetry/digest", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@reranker/telemetry/digest")>()),
  ...sources,
}));
const telemetry = vi.hoisted(() => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  sendOpsAlert: vi.fn(async () => {}),
}));
vi.mock("@reranker/telemetry", () => telemetry);
const jobs = vi.hoisted(() => ({
  checkWorkflowQuota: vi.fn(),
  consumeQuota: vi.fn(async () => {}),
  reportStepError: vi.fn(async () => {}),
}));
vi.mock("@reranker/jobs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@reranker/jobs")>()),
  ...jobs,
}));
const db = vi.hoisted(() => ({ withSystem: vi.fn() }));
vi.mock("@reranker/db", () => db);
const neon = vi.hoisted(() => ({ readNeonUsage: vi.fn() }));
vi.mock("@reranker/db/neon-usage", () => neon);
const flags = vi.hoisted(() => ({ captureSwitchSnapshot: vi.fn() }));
vi.mock("@reranker/flags", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@reranker/flags")>()),
  ...flags,
}));

const { QuotaExceededError } = await import("@reranker/jobs");
const { opsDigest, runDailyDigest } = await import("./daily-digest");

const SPEND_ROWS = [
  {
    scope: "global",
    currency: "USD",
    day_used: "12500000",
    day_cap: "75000000",
    month_used: "80000000",
  },
  {
    scope: "provider:dataforseo",
    currency: "USD",
    day_used: "36000000",
    day_cap: "36000000",
    month_used: "70000000",
  },
];

// Each read goes through its own system transaction; the reason names which one.
function serveDatabase() {
  db.withSystem.mockImplementation(async (reason: string) => {
    if (reason === "ops.digest.spend") return { rows: SPEND_ROWS };
    if (reason === "ops.digest.resend") return { rows: [{ quota: 10, alerts: 2 }] };
    throw new Error(`unexpected read ${reason}`);
  });
}

function project(projectId: string, computeHours: number) {
  return {
    projectId,
    periodStart: "2026-11-01T00:00:00.000Z",
    periodEnd: "2026-12-01T00:00:00.000Z",
    computeHours,
    computeHoursLimit: 100,
    storageBytes: 1024 ** 3,
    storageBytesLimit: 1_073_741_824,
    computePct: computeHours,
    storagePct: 100,
  };
}

const text = () => (sources.sendDailyDigest.mock.calls[0] as unknown as [string, string])[1];

beforeEach(() => {
  vi.stubEnv("APP_ENV", "production");
  vi.stubEnv("NEON_API_KEY", "napi_test");
  vi.stubEnv("NEON_PROJECT_ID", "prod-id");
  vi.stubEnv("NEON_NONPROD_PROJECT_ID", "nonprod-id");
  vi.stubEnv(
    "BETTERSTACK_HEARTBEAT_DAILY_URL",
    "https://uptime.betterstack.com/api/v1/heartbeat/x",
  );
  serveDatabase();
  sources.dataforseoBalance.mockResolvedValue({ balanceUsd: 40 });
  sources.githubActionsUsage.mockResolvedValue({
    minutesUsed: 100,
    includedUsedUsd: 0.6,
    includedUsd: 12,
    billedUsd: 0,
  });
  sources.posthogUsage.mockResolvedValue({ events: 1000, exceptions: 3 });
  neon.readNeonUsage.mockResolvedValue({
    projects: [project("prod-id", 10), project("nonprod-id", 4)],
  });
  jobs.checkWorkflowQuota.mockResolvedValue({ estimatedEvents: 900, ratio: 0.018 });
  flags.captureSwitchSnapshot.mockResolvedValue({
    switches: { "capture-provider-dataforseo": true },
    evaluatedAt: "2026-11-17T10:00:00.000Z",
    definitionsEtag: null,
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

test("gathers every source, emails the digest and then pings the heartbeat", async () => {
  const result = await runDailyDigest("2026-11-17");
  expect(result).toEqual({ sent: true, alerts: 0, missing: [] });
  expect(jobs.consumeQuota).toHaveBeenCalledExactlyOnceWith("resend.emails", { priority: "high" });
  expect(sources.sendDailyDigest).toHaveBeenCalledExactlyOnceWith("2026-11-17", expect.any(String));
  expect(sources.pingHeartbeat).toHaveBeenCalledExactlyOnceWith(
    "https://uptime.betterstack.com/api/v1/heartbeat/x",
  );
  expect(text()).toContain("Gasto del 2026-11-16");
  expect(text()).toContain("reranker-prod: 10 CU-h");
  expect(text()).toContain("reranker-nonprod: 4 CU-h");
  expect(text()).toContain("Resend: 12 correos el 2026-11-16");
  expect(text()).toContain("Topes alcanzados el 2026-11-16: provider:dataforseo");
  expect(text()).toContain("capture-provider-dataforseo: encendido");
  expect(sources.githubActionsUsage).toHaveBeenCalledWith("2026-11", expect.any(AbortSignal));
  expect(jobs.checkWorkflowQuota).toHaveBeenCalledExactlyOnceWith("2026-11");
});

test("the closed day of a month's first run is the previous month's last day", async () => {
  await runDailyDigest("2026-12-01");
  expect(text()).toContain("Gasto del 2026-11-30");
  expect(jobs.checkWorkflowQuota).toHaveBeenCalledExactlyOnceWith("2026-11");
});

test("a source that never answers is 'sin dato' after 10 s and the email still goes out", async () => {
  vi.useFakeTimers();
  sources.posthogUsage.mockImplementation(() => new Promise(() => {}));
  const run = runDailyDigest("2026-11-17");
  await vi.advanceTimersByTimeAsync(10_000);
  const result = await run;
  expect(result).toEqual({ sent: true, alerts: 0, missing: ["posthog"] });
  expect(text()).toContain("PostHog: sin dato (sin respuesta en 10 s)");
  expect(sources.pingHeartbeat).toHaveBeenCalledOnce();
});

test("sources without their credentials are 'sin dato' and named in the log", async () => {
  vi.stubEnv("NEON_API_KEY", "");
  const result = await runDailyDigest("2026-11-17");
  expect(result.missing).toEqual(["neon"]);
  expect(text()).toMatch(/Neon: sin dato \(falta NEON_API_KEY/);
  expect(neon.readNeonUsage).not.toHaveBeenCalled();
  expect(telemetry.log.warn).toHaveBeenCalledWith("ops.digest.sources_missing", {
    date: "2026-11-17",
    sources: "neon",
  });
});

test("each crossed threshold is sent as its alert before the email", async () => {
  sources.posthogUsage.mockResolvedValue({ events: 960_000, exceptions: 0 });
  const result = await runDailyDigest("2026-11-17");
  expect(result.alerts).toBe(1);
  expect(telemetry.sendOpsAlert).toHaveBeenCalledExactlyOnceWith(
    "free-tier-quota",
    expect.objectContaining({ source: "posthog-events", severity: "critical" }),
  );
});

test("if Resend fails there is no heartbeat ping", async () => {
  sources.sendDailyDigest.mockResolvedValueOnce(false);
  expect(await runDailyDigest("2026-11-17")).toMatchObject({ sent: false });
  expect(sources.pingHeartbeat).not.toHaveBeenCalled();
});

test("the high class of the Resend quota exhausted → no email, logged as an error", async () => {
  jobs.consumeQuota.mockRejectedValueOnce(
    new QuotaExceededError("resend.emails", "high", new Date("2026-11-18T05:00:00Z")),
  );
  expect(await runDailyDigest("2026-11-17")).toMatchObject({ sent: false });
  expect(sources.sendDailyDigest).not.toHaveBeenCalled();
  expect(sources.pingHeartbeat).not.toHaveBeenCalled();
  expect(telemetry.log.error).toHaveBeenCalledWith("ops.digest.quota_exceeded", {
    date: "2026-11-17",
  });
});

test("without the operations inbox nothing is sent or counted, and it is logged", async () => {
  sources.digestEmailConfigured.mockReturnValueOnce(false);
  expect(await runDailyDigest("2026-11-17")).toMatchObject({ sent: false });
  expect(jobs.consumeQuota).not.toHaveBeenCalled();
  expect(sources.sendDailyDigest).not.toHaveBeenCalled();
  expect(telemetry.log.warn).toHaveBeenCalledWith("ops.digest.email_unconfigured", {
    date: "2026-11-17",
  });
});

test("without a heartbeat URL the email still goes out", async () => {
  vi.stubEnv("BETTERSTACK_HEARTBEAT_DAILY_URL", "");
  expect(await runDailyDigest("2026-11-17")).toMatchObject({ sent: true });
  expect(sources.pingHeartbeat).not.toHaveBeenCalled();
  expect(telemetry.log.warn).toHaveBeenCalledWith("ops.digest.heartbeat_unconfigured");
});

test("a failed ping is logged and the run still counts as sent", async () => {
  sources.pingHeartbeat.mockRejectedValueOnce(new Error("503"));
  expect(await runDailyDigest("2026-11-17")).toMatchObject({ sent: true });
  expect(telemetry.log.error).toHaveBeenCalledWith("ops.digest.heartbeat_failed", {
    error: "Error",
  });
});

test("opsDigest is a daily step that reports and rethrows an unexpected failure", async () => {
  expect(opsDigest.name).toBe("opsDigest");
  const error = new Error("connection refused");
  jobs.consumeQuota.mockRejectedValueOnce(error);
  await expect(opsDigest.run("2026-11-17")).rejects.toBe(error);
  expect(jobs.reportStepError).toHaveBeenCalledExactlyOnceWith("daily", "opsDigest", error);
});

test("opsDigest maps a failure retrying cannot fix to a fatal one", async () => {
  const { InvalidInputError } = await import("@reranker/jobs");
  jobs.consumeQuota.mockRejectedValueOnce(new InvalidInputError("bad"));
  await expect(opsDigest.run("2026-11-17")).rejects.toBeInstanceOf(FatalError);
});
