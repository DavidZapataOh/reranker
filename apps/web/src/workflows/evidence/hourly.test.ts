import { beforeEach, expect, test, vi } from "vitest";
import { FatalError } from "workflow";

// Without the workflow compiler steps are plain functions, so the run executes here directly
// against doubles of the package functions it wraps.
const evidence = vi.hoisted(() => ({
  announceKeys: vi.fn(),
  anchorLatest: vi.fn(),
  upgradePendingOts: vi.fn(),
  logOrigin: () => "log.reranker.co/captures/2026",
}));
vi.mock("@reranker/evidence", () => evidence);
const jobs = vi.hoisted(() => ({ reportStepError: vi.fn(async () => {}) }));
vi.mock("@reranker/jobs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@reranker/jobs")>()),
  ...jobs,
}));
const telemetry = vi.hoisted(() => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("@reranker/telemetry", () => telemetry);

const { InvalidInputError } = await import("@reranker/jobs");
const { hourlyEvidenceWorkflow } = await import("./hourly");

beforeEach(() => {
  vi.clearAllMocks();
  evidence.anchorLatest.mockResolvedValue({
    treeSize: 42,
    ots: "pending",
    tsa: { qtsa: "confirmed", digicert: "failed" },
  });
  evidence.upgradePendingOts.mockResolvedValue({ checked: 3, confirmed: 1, overdue: 0 });
  evidence.announceKeys.mockResolvedValue({ announced: [] });
});

test("logs the keys it announces, and nothing once they are on the record", async () => {
  evidence.announceKeys.mockResolvedValueOnce({ announced: ["rr-capture-2026-1-ed25519"] });
  expect(await hourlyEvidenceWorkflow("2026-11-18T13")).toEqual({ failed: [] });
  expect(telemetry.log.info).toHaveBeenCalledWith("evidence.hourly.keys_announced", {
    hour: "2026-11-18T13",
    announced: ["rr-capture-2026-1-ed25519"],
  });
  vi.mocked(telemetry.log.info).mockClear();
  expect(await hourlyEvidenceWorkflow("2026-11-18T14")).toEqual({ failed: [] });
  expect(telemetry.log.info).not.toHaveBeenCalledWith(
    "evidence.hourly.keys_announced",
    expect.anything(),
  );
});

test("a failed announcement is reported and anchoring runs anyway", async () => {
  evidence.announceKeys.mockRejectedValue(new Error("KMS is unreachable"));
  expect(await hourlyEvidenceWorkflow("2026-11-18T12")).toEqual({ failed: ["announceKeys"] });
  expect(evidence.anchorLatest).toHaveBeenCalledOnce();
  expect(evidence.upgradePendingOts).toHaveBeenCalledOnce();
});

test("anchors this deployment's log, then upgrades waiting proofs", async () => {
  expect(await hourlyEvidenceWorkflow("2026-11-18T14")).toEqual({ failed: [] });
  expect(evidence.anchorLatest).toHaveBeenCalledExactlyOnceWith("log.reranker.co/captures/2026");
  expect(telemetry.log.info).toHaveBeenCalledWith("evidence.hourly.anchor", {
    hour: "2026-11-18T14",
    tree_size: 42,
    ots: "pending",
    qtsa: "confirmed",
    digicert: "failed",
  });
  expect(telemetry.log.info).toHaveBeenCalledWith("evidence.hourly.ots_upgrade", {
    hour: "2026-11-18T14",
    checked: 3,
    confirmed: 1,
    overdue: 0,
  });
});

test("an hour with nothing new still upgrades", async () => {
  evidence.anchorLatest.mockResolvedValue({ treeSize: null });
  expect(await hourlyEvidenceWorkflow("2026-11-18T15")).toEqual({ failed: [] });
  expect(telemetry.log.info).toHaveBeenCalledWith("evidence.hourly.anchor", {
    hour: "2026-11-18T15",
    tree_size: "none",
  });
  expect(evidence.upgradePendingOts).toHaveBeenCalledOnce();
});

test("a failed anchor is reported and the upgrade runs anyway", async () => {
  evidence.anchorLatest.mockRejectedValue(new InvalidInputError("bad origin"));
  expect(await hourlyEvidenceWorkflow("2026-11-18T16")).toEqual({ failed: ["anchorLatest"] });
  expect(jobs.reportStepError).toHaveBeenCalledWith(
    "evidence-hourly",
    "anchorLatest",
    expect.any(InvalidInputError),
  );
  expect(telemetry.log.error).toHaveBeenCalledWith("evidence.hourly.step_failed", {
    step: "anchorLatest",
    hour: "2026-11-18T16",
    error: expect.stringContaining("bad origin"),
  });
  expect(evidence.upgradePendingOts).toHaveBeenCalledOnce();
});

test("a non-retryable failure reaches the runtime as a fatal step error", async () => {
  const error = new InvalidInputError("broken proof");
  evidence.upgradePendingOts.mockRejectedValue(error);
  expect(await hourlyEvidenceWorkflow("2026-11-18T17")).toEqual({ failed: ["upgradePendingOts"] });
  expect(telemetry.log.error).toHaveBeenCalledWith("evidence.hourly.step_failed", {
    step: "upgradePendingOts",
    hour: "2026-11-18T17",
    error: new FatalError(`${error.name}: broken proof`).message,
  });
});
