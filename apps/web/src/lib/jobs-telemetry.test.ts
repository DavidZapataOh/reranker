import { beforeEach, expect, test, vi } from "vitest";

const telemetry = vi.hoisted(() => ({ captureServerEvent: vi.fn(), sendOpsAlert: vi.fn() }));
vi.mock("@reranker/telemetry", () => telemetry);

const { jobsTelemetry } = await import("./jobs-telemetry");

beforeEach(() => {
  telemetry.captureServerEvent.mockReset();
  telemetry.sendOpsAlert.mockReset().mockResolvedValue(undefined);
});

test("captures each jobs event as a system server event, unchanged", () => {
  const event = {
    name: "jobs.lease.wait_ms",
    props: { provider: "dataforseo", wait_ms: 120 },
  } as const;
  jobsTelemetry.capture(event);
  expect(telemetry.captureServerEvent).toHaveBeenCalledExactlyOnceWith(event, {
    subject: { system: true },
  });
});

test("sends each jobs alert as the ops alert of the same kind", async () => {
  await jobsTelemetry.alert("jobs-breaker-open", { provider: "openai", open_minutes: 6 });
  expect(telemetry.sendOpsAlert).toHaveBeenCalledExactlyOnceWith("jobs-breaker-open", {
    provider: "openai",
    open_minutes: 6,
  });
});
