import { beforeEach, expect, test, vi } from "vitest";

const launch = vi.hoisted(() => ({ checkVercelBilling: vi.fn() }));
vi.mock("@reranker/telemetry/launch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@reranker/telemetry/launch")>()),
  ...launch,
}));
const telemetry = vi.hoisted(() => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  sendOpsAlert: vi.fn(async () => {}),
}));
vi.mock("@reranker/telemetry", () => telemetry);
const jobs = vi.hoisted(() => ({ reportStepError: vi.fn(async () => {}) }));
vi.mock("@reranker/jobs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@reranker/jobs")>()),
  ...jobs,
}));

const { runVercelBillingCheck, vercelBilling } = await import("./vercel-billing");

beforeEach(() => {
  vi.clearAllMocks();
});

test("a blocked or unpaid team is a critical alert with its reason", async () => {
  launch.checkVercelBilling.mockResolvedValue({
    id: "vercel-billing",
    status: "fail",
    reason: "Vercel tiene bloqueado el equipo (UNPAID_INVOICE); reranker.co responde 402",
  });
  await runVercelBillingCheck();
  expect(telemetry.sendOpsAlert).toHaveBeenCalledExactlyOnceWith("vercel-billing", {
    reason: "Vercel tiene bloqueado el equipo (UNPAID_INVOICE); reranker.co responde 402",
  });
});

test("a paid-up team stays quiet", async () => {
  launch.checkVercelBilling.mockResolvedValue({
    id: "vercel-billing",
    status: "pass",
    reason: "ok",
  });
  await runVercelBillingCheck();
  expect(telemetry.sendOpsAlert).not.toHaveBeenCalled();
  expect(telemetry.log.info).toHaveBeenCalledWith("jobs.daily.vercel_billing", { status: "pass" });
});

test("a status it cannot read is a warning in the logs, never a silent pass", async () => {
  launch.checkVercelBilling.mockResolvedValue({
    id: "vercel-billing",
    status: "unknown",
    reason: "falta VERCEL_BILLING_READ_TOKEN",
  });
  await runVercelBillingCheck();
  expect(telemetry.sendOpsAlert).not.toHaveBeenCalled();
  expect(telemetry.log.warn).toHaveBeenCalledWith("ops.vercel_billing.unverified", {
    reason: "falta VERCEL_BILLING_READ_TOKEN",
  });
});

test("a check that does not answer in time is unverified too", async () => {
  vi.useFakeTimers();
  try {
    launch.checkVercelBilling.mockReturnValue(new Promise(() => {}));
    const run = runVercelBillingCheck();
    await vi.advanceTimersByTimeAsync(10_000);
    await run;
  } finally {
    vi.useRealTimers();
  }
  expect(telemetry.log.warn).toHaveBeenCalledWith("ops.vercel_billing.unverified", {
    reason: "sin respuesta en 10 s",
  });
});

test("vercelBilling is a daily step that reports a failure under its name", async () => {
  expect(vercelBilling.name).toBe("vercelBilling");
  const error = new Error("boom");
  telemetry.sendOpsAlert.mockRejectedValueOnce(error);
  launch.checkVercelBilling.mockResolvedValue({
    id: "vercel-billing",
    status: "fail",
    reason: "x",
  });
  await expect(vercelBilling.run("2026-11-17")).rejects.toThrow();
  expect(jobs.reportStepError).toHaveBeenCalledExactlyOnceWith("daily", "vercelBilling", error);
});
