import { LAUNCH_CHECK_IDS } from "@reranker/telemetry/launch";
import { beforeEach, expect, test, vi } from "vitest";

const state = vi.hoisted(() => ({
  deploymentInputs: vi.fn(() => ({ crons: [], tracing: true, resendDailyQuota: 1_600 })),
  readGatedFlags: vi.fn(),
}));
vi.mock("../../lib/launch-state", () => state);
const launch = vi.hoisted(() => ({ runLaunchCheck: vi.fn() }));
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

const { launchGate, runLaunchGate } = await import("./launch-gate");

const passing = LAUNCH_CHECK_IDS.map((id) => ({ id, status: "pass" as const, reason: "ok" }));
const withStatus = (id: string, status: "fail" | "unknown", reason: string) =>
  passing.map((r) => (r.id === id ? { ...r, status, reason } : r));

beforeEach(() => {
  vi.clearAllMocks();
  launch.runLaunchCheck.mockResolvedValue(passing);
  state.readGatedFlags.mockResolvedValue({ "free-report-live": false, accounts: false });
});

test("checks the deployment's own inputs and stays quiet while the gated flags are off", async () => {
  launch.runLaunchCheck.mockResolvedValue(withStatus("traces", "fail", "sin trazas"));
  await runLaunchGate();
  expect(launch.runLaunchCheck).toHaveBeenCalledExactlyOnceWith(state.deploymentInputs());
  expect(telemetry.sendOpsAlert).not.toHaveBeenCalled();
  expect(telemetry.log.info).toHaveBeenCalledWith(
    "jobs.daily.launch_gate",
    expect.objectContaining({ fail: "traces", "free-report-live": false }),
  );
});

test("a gated flag on with a failing stage is a critical alert", async () => {
  state.readGatedFlags.mockResolvedValue({ "free-report-live": true, accounts: false });
  launch.runLaunchCheck.mockResolvedValue(
    withStatus("neon-production", "fail", "escala a cero encendida"),
  );
  await runLaunchGate();
  expect(telemetry.sendOpsAlert).toHaveBeenCalledExactlyOnceWith("launch-gate-violated", {
    flag: "free-report-live",
    failing: "neon-production",
    unknown: "",
    reasons: "neon-production: escala a cero encendida",
    severity: "critical",
  });
});

test("a check only unverified warns, and a flag whose gate passes is fine", async () => {
  state.readGatedFlags.mockResolvedValue({ "free-report-live": true, accounts: true });
  launch.runLaunchCheck.mockResolvedValue(withStatus("traces", "unknown", "sin respuesta"));
  await runLaunchGate();
  expect(telemetry.sendOpsAlert).toHaveBeenCalledExactlyOnceWith(
    "launch-gate-violated",
    expect.objectContaining({ flag: "free-report-live", unknown: "traces", severity: "warning" }),
  );
});

test("flags that cannot be read are an error, never a silent pass", async () => {
  state.readGatedFlags.mockRejectedValue(new Error("401"));
  await runLaunchGate();
  expect(telemetry.sendOpsAlert).not.toHaveBeenCalled();
  expect(telemetry.log.error).toHaveBeenCalledWith(
    "ops.launch_gate.flags_unreadable",
    expect.objectContaining({ detail: expect.any(String) }),
  );
});

test("launchGate is a daily step", () => {
  expect(launchGate.name).toBe("launchGate");
});
