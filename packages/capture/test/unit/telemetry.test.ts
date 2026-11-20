import { cost } from "@reranker/schema";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

// An in-memory stand-in for the ten-minute window that ops.record_velocity keeps in Postgres.
const windows = new Map<string, { count10m: number; flagged10m: number }>();
const velocity = vi.hoisted(() => ({ recordVelocity: vi.fn() }));
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
  velocity.recordVelocity.mockImplementation(async (key: string, sample: { flagged: boolean }) => {
    const w = windows.get(key) ?? { count10m: 0, flagged10m: 0 };
    const next = { count10m: w.count10m + 1, flagged10m: w.flagged10m + (sample.flagged ? 1 : 0) };
    windows.set(key, next);
    return { ...next, spend10m: cost(0, "USD"), spend60m: cost(0, "USD") };
  });
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
  expect(velocity.recordVelocity).not.toHaveBeenCalled();
});

test("a failing velocity store never reaches the caller", async () => {
  velocity.recordVelocity.mockRejectedValue(new Error("db down"));
  await record([call()]);
  expect(telemetry.log.warn).toHaveBeenCalledWith("capture.velocity_failed", {
    key: "capture:dataforseo:errors",
    error: "Error",
  });
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
