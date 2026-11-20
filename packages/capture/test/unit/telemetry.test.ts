import { AppError, cost } from "@reranker/schema";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

// An in-memory stand-in for the ten-minute window that ops.record_velocity keeps in Postgres.
const windows = new Map<string, { count10m: number; flagged10m: number }>();
const velocity = vi.hoisted(() => ({ recordVelocities: vi.fn() }));
vi.mock("@reranker/jobs/velocity", () => velocity);

const telemetry = vi.hoisted(() => ({
  captureServerEvent: vi.fn(),
  sendOpsAlert: vi.fn(async (_kind: string, _payload?: Record<string, unknown>) => {}),
  runAfter: vi.fn(),
  log: { warn: vi.fn() },
}));
vi.mock("@reranker/telemetry", () => telemetry);

const { captureCallOf, recordCaptureCall } = await import("../../src/telemetry");

const pending: Promise<void>[] = [];

beforeEach(() => {
  windows.clear();
  velocity.recordVelocities.mockImplementation(
    async (samples: { key: string; flagged: boolean }[]) =>
      samples.map(({ key, flagged }) => {
        const w = windows.get(key) ?? { count10m: 0, flagged10m: 0 };
        const next = { count10m: w.count10m + 1, flagged10m: w.flagged10m + (flagged ? 1 : 0) };
        windows.set(key, next);
        return { ...next, spend10m: cost(0, "USD"), spend60m: cost(0, "USD") };
      }),
  );
  telemetry.runAfter.mockImplementation((fn: () => Promise<void>) => {
    pending.push(fn());
  });
});

afterEach(() => {
  vi.clearAllMocks();
  pending.length = 0;
});

async function flush() {
  // Each call's window is recorded before the next one starts, as calls finish one by one.
  while (pending.length > 0) await pending.shift();
}

const call = (over: Partial<Parameters<typeof recordCaptureCall>[0]> = {}) => ({
  engine: "gemini" as const,
  provider: "dataforseo" as const,
  channel: "ui-vendor" as const,
  mode: "live" as const,
  status: "succeeded" as const,
  latencyMs: 27_000,
  cost: cost(4000, "USD"),
  parseFailed: false,
  surfaceAbsent: false,
  late: false,
  providerStatusCode: 20000,
  ...over,
});

async function record(calls: ReturnType<typeof call>[]) {
  for (const c of calls) {
    recordCaptureCall(c);
    await flush();
  }
}

const alerts = (kind: string) =>
  telemetry.sendOpsAlert.mock.calls.filter(([k]) => k === kind) as unknown as [
    string,
    Record<string, unknown>,
  ][];

test("one event per call with its outcome", async () => {
  await record([call({ status: "provider_error", cost: null, parseFailed: true, late: true })]);
  expect(telemetry.captureServerEvent).toHaveBeenCalledOnce();
  expect(telemetry.captureServerEvent).toHaveBeenCalledWith(
    {
      name: "capture_call",
      props: {
        engine: "gemini",
        provider: "dataforseo",
        channel: "ui-vendor",
        mode: "live",
        status: "provider_error",
        latency_ms: 27_000,
        cost_micros: null,
        parse_failed: true,
        surface_absent: false,
        late: true,
      },
    },
    { subject: { system: true } },
  );
});

test("error rate above 20% with 20 calls alerts once", async () => {
  const failed = call({ status: "provider_error", providerStatusCode: 50000 });
  await record([
    ...Array.from({ length: 15 }, () => call()),
    ...Array.from({ length: 4 }, () => failed),
  ]);
  expect(alerts("capture-dataforseo-errors")).toHaveLength(0);
  // 5 of 20 failed: the call that crosses 20% alerts, the ones after it do not.
  await record([failed, failed, failed]);
  expect(alerts("capture-dataforseo-errors")).toEqual([
    ["capture-dataforseo-errors", { calls_10m: 20, failed_10m: 5 }],
  ]);
});

test("no call is counted as an error until 20 calls are in the window", async () => {
  await record(Array.from({ length: 19 }, () => call({ status: "timeout", cost: null })));
  expect(alerts("capture-dataforseo-errors")).toHaveLength(0);
});

test("a 40210 alerts balance immediately", async () => {
  await record([call({ status: "provider_error", providerStatusCode: 40210, alert: "balance" })]);
  expect(alerts("capture-dataforseo-balance")).toEqual([
    ["capture-dataforseo-balance", { engine: "gemini", provider_status_code: 40210 }],
  ]);
});

test("parse failures above 5% alert", async () => {
  await record([...Array.from({ length: 18 }, () => call()), call({ parseFailed: true })]);
  expect(alerts("capture-parse-failed")).toHaveLength(0);
  await record([call({ parseFailed: true })]);
  expect(alerts("capture-parse-failed")).toEqual([
    ["capture-parse-failed", { calls_10m: 20, parse_failed_10m: 2 }],
  ]);
});

test("a call that brought nothing back is an error but no parse failure", async () => {
  await record([call({ status: "no_response", cost: null, providerStatusCode: null })]);
  expect(windows.get("capture:dataforseo:errors")).toEqual({ count10m: 1, flagged10m: 1 });
  expect(windows.get("capture:dataforseo:parse")).toBeUndefined();
});

test("providers without DataForSEO alerts only emit the event", async () => {
  await record([call({ provider: "brightdata", engine: "perplexity", status: "provider_error" })]);
  expect(telemetry.captureServerEvent).toHaveBeenCalledOnce();
  expect(velocity.recordVelocities).not.toHaveBeenCalled();
});

test("both windows of a call are recorded in one round trip", async () => {
  await record([call()]);
  expect(velocity.recordVelocities).toHaveBeenCalledOnce();
  expect(velocity.recordVelocities.mock.calls[0]?.[0]).toHaveLength(2);
});

test("a failing velocity store never reaches the caller", async () => {
  velocity.recordVelocities.mockRejectedValue(new Error("db down"));
  await record([call()]);
  expect(telemetry.log.warn).toHaveBeenCalledWith("capture.velocity_failed", {
    calls: 1,
    error: "Error",
  });
  // The writer recovers: the next call is recorded.
  velocity.recordVelocities.mockReset().mockResolvedValue([]);
  await record([call()]);
  expect(velocity.recordVelocities).toHaveBeenCalledOnce();
});

const checkoutTimeout = () =>
  new AppError("service_unavailable", {
    retryAfterSeconds: 2,
    cause: new Error("timeout exceeded when trying to connect"),
  });

test("a batch whose checkout timed out is written again with the calls that finished meanwhile", async () => {
  velocity.recordVelocities.mockImplementationOnce(async () => {
    recordCaptureCall(call({ status: "provider_error", providerStatusCode: 50000 }));
    throw checkoutTimeout();
  });
  recordCaptureCall(call());
  await flush();
  expect(velocity.recordVelocities).toHaveBeenCalledTimes(2);
  expect(velocity.recordVelocities.mock.calls[1]?.[0]).toHaveLength(2 * 2);
  expect(windows.get("capture:dataforseo:errors")).toEqual({ count10m: 2, flagged10m: 1 });
  expect(telemetry.log.warn).not.toHaveBeenCalled();
});

test("a call that has waited 30 s for a connection gives its windows up", async () => {
  const now = vi.spyOn(performance, "now").mockReturnValue(1_000);
  velocity.recordVelocities.mockImplementation(async () => {
    now.mockReturnValue(31_000);
    throw checkoutTimeout();
  });
  await record([call()]);
  expect(velocity.recordVelocities).toHaveBeenCalledOnce();
  expect(telemetry.log.warn).toHaveBeenCalledWith("capture.velocity_failed", {
    calls: 1,
    error: "AppError",
  });
  now.mockRestore();
});

test("calls that finish while a write is in flight go together in the next one", async () => {
  const record = velocity.recordVelocities.getMockImplementation();
  const gate = Promise.withResolvers<void>();
  velocity.recordVelocities.mockImplementationOnce(async (samples) => {
    await gate.promise;
    return record?.(samples);
  });
  const failed = call({ status: "provider_error", providerStatusCode: 50000 });
  // 15 succeeded calls write first, alone or batched; the alert must still come from the 20th.
  recordCaptureCall(call());
  for (let i = 0; i < 14; i++) recordCaptureCall(call());
  for (let i = 0; i < 7; i++) recordCaptureCall(failed);
  gate.resolve();
  await flush();
  expect(velocity.recordVelocities).toHaveBeenCalledTimes(2);
  expect(velocity.recordVelocities.mock.calls[0]?.[0]).toHaveLength(2);
  expect(velocity.recordVelocities.mock.calls[1]?.[0]).toHaveLength(21 * 2);
  expect(windows.get("capture:dataforseo:errors")).toEqual({ count10m: 22, flagged10m: 7 });
  expect(alerts("capture-dataforseo-errors")).toEqual([
    ["capture-dataforseo-errors", { calls_10m: 20, failed_10m: 5 }],
  ]);
});

test("captureCallOf reads the outcome off the stored record", () => {
  const answer = { present: false } as never;
  const out = captureCallOf(
    {
      slot: { engine: "google-ai-overview", provider: "dataforseo" },
      status: "succeeded",
      providerStatusCode: 20000,
      latencyMs: 6000,
      cost: cost(2000, "USD"),
      parseError: null,
      answer,
      mode: "live",
    } as never,
    { channel: "ui-vendor", late: false },
  );
  expect(out).toEqual(
    call({
      engine: "google-ai-overview",
      latencyMs: 6000,
      cost: cost(2000, "USD"),
      surfaceAbsent: true,
    }),
  );
});
