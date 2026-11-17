import { sanitizeServerProps } from "@reranker/analytics";
import { resetAppEnv } from "@reranker/env";
import { AppError, cost } from "@reranker/schema";
import { scrub } from "@reranker/telemetry/scrub";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterAll, beforeEach, describe, expect, test, vi } from "vitest";

const execute = vi.fn();
const withSystem = vi.fn(async (_reason: string, fn: (tx: unknown) => unknown) => fn({ execute }));
vi.mock("@reranker/db", () => ({ withSystem }));

// An in-memory token bucket with the semantics of ops.take_tokens, on the test's clock.
const buckets = new Map<string, { tokens: number; at: number }>();
const takeTokens = vi.fn(
  async (key: string, limits: { capacity: number; refillPerSecond: number }, n = 1) => {
    const now = Date.now();
    const bucket = buckets.get(key) ?? { tokens: limits.capacity, at: now };
    const tokens = Math.min(
      limits.capacity,
      bucket.tokens + ((now - bucket.at) / 1000) * limits.refillPerSecond,
    );
    const ok = tokens >= n;
    buckets.set(key, { tokens: ok ? tokens - n : tokens, at: now });
    const retryAfterMs = ok ? 0 : Math.ceil(((n - tokens) / limits.refillPerSecond) * 1000);
    return { ok, remaining: ok ? tokens - n : tokens, retryAfterMs };
  },
);
vi.mock("../src/rate", () => ({ takeTokens }));

const guardModeSince = vi.fn<(name: string) => Promise<Date | null>>();
const tripGuardMode = vi.fn(async () => ({
  active: true as const,
  activeUntil: new Date(Date.now() + 60_000),
  newlyTripped: false,
}));
vi.mock("../src/guard-mode", () => ({ guardModeSince, tripGuardMode }));

const savedAppEnv = process.env.APP_ENV;
process.env.APP_ENV = "production";
resetAppEnv();
afterAll(() => {
  process.env.APP_ENV = savedAppEnv;
  resetAppEnv();
});

const { SpendCapExceededError, RateLimitedError, ProviderRejectedError } = await import(
  "../src/errors"
);
const { reserveSpend } = await import("../src/spend");
const { breakerCheck } = await import("../src/breaker");
const { providerCapacity, registerCapacitySource } = await import("../src/capacity");
const { registerJobsTelemetry, reportStepError, resetJobsTelemetryForTest } = await import(
  "../src/telemetry"
);
type JobsEvent = import("../src/telemetry").JobsEvent;
type JobsAlertKind = import("../src/telemetry").JobsAlertKind;

const ID = "0190a6c4-2f1b-7c3e-8a5d-9e8f7a6b5c4d";
const MINUTE = 60_000;
const dialect = new PgDialect();
const statement = (query: SQL) => dialect.sqlToQuery(query);

let events: JobsEvent[] = [];
let alerts: Array<{ kind: JobsAlertKind; payload: Record<string, string | number | boolean> }> = [];
const sink = {
  capture: (event: JobsEvent) => {
    events.push(event);
  },
  alert: async (kind: JobsAlertKind, payload: Record<string, string | number | boolean>) => {
    alerts.push({ kind, payload });
  },
};

beforeEach(() => {
  execute.mockReset();
  withSystem.mockClear();
  takeTokens.mockClear();
  guardModeSince.mockReset();
  tripGuardMode.mockClear();
  buckets.clear();
  events = [];
  alerts = [];
  resetJobsTelemetryForTest();
  registerJobsTelemetry(sink);
});

// Reserves each amount against one global cap the fake database keeps, as ops.reserve_spend does.
async function simulateReservations({ cap, amounts }: { cap: number; amounts: number[] }) {
  let used = 0;
  execute.mockImplementation(async (query: SQL) => {
    const { sql, params } = statement(query);
    if (!sql.includes("ops.reserve_spend")) throw new Error(`unexpected statement: ${sql}`);
    const amount = Number(params[5]);
    if (used + amount > cap) {
      return {
        rows: [{ ledger_id: null, denied_scope: "global", scopes: [], used: [], caps: [] }],
      };
    }
    used += amount;
    return {
      rows: [
        {
          ledger_id: ID,
          denied_scope: null,
          scopes: ["global"],
          used: [String(used)],
          caps: [String(cap)],
        },
      ],
    };
  });
  for (const amount of amounts) {
    await reserveSpend({
      provider: "dataforseo",
      purpose: "benchmark",
      refType: "benchmark",
      refId: "b1",
      estimate: cost(amount, "USD"),
    }).catch((error: unknown) => {
      if (!(error instanceof SpendCapExceededError)) throw error;
    });
  }
}

const ofKind = (kind: JobsAlertKind) => alerts.filter((alert) => alert.kind === kind);

describe("spend", () => {
  test("crossing 80% and 100% of a scope alerts once each", async () => {
    await simulateReservations({ cap: 1_000_000, amounts: [700_000, 150_000, 150_000, 10_000] });
    expect(ofKind("jobs-spend-cap-reached").map((a) => a.payload.threshold)).toEqual([80, 100]);
    expect(ofKind("jobs-spend-cap-reached")[1]?.payload).toMatchObject({
      scope: "global",
      severity: "critical",
      used_micros: 1_000_000,
      cap_micros: 1_000_000,
    });
    expect(events).toContainEqual(
      expect.objectContaining({ name: "jobs.spend.cap_reached", props: { scope: "global" } }),
    );
    expect(events.filter((e) => e.name === "jobs.spend.reserved")).toHaveLength(3);
    expect(events).toContainEqual({
      name: "jobs.spend.reserved",
      props: { provider: "dataforseo", purpose: "benchmark", micro_usd: 700_000 },
    });
  });

  test("a denial before any reservation filled the cap still alerts at 100%, once", async () => {
    await simulateReservations({ cap: 1_000_000, amounts: [900_000, 200_000, 200_000] });
    expect(ofKind("jobs-spend-cap-reached").map((a) => a.payload.threshold)).toEqual([80, 100]);
    expect(events.filter((e) => e.name === "jobs.spend.cap_reached")).toHaveLength(2);
  });

  test("another instance that already alerted keeps this one quiet", async () => {
    await simulateReservations({ cap: 1_000_000, amounts: [850_000] });
    resetJobsTelemetryForTest();
    registerJobsTelemetry(sink);
    alerts = [];
    await simulateReservations({ cap: 1_000_000, amounts: [850_000] });
    expect(ofKind("jobs-spend-cap-reached")).toEqual([]);
  });
});

describe("breaker", () => {
  const breakerRow = (state: string, openedAgoMs: number | null) => ({
    rows: [
      {
        state,
        retry_after_ms: state === "open" ? 10_000 : 0,
        opened_at: openedAgoMs === null ? null : new Date(Date.now() - openedAgoMs),
      },
    ],
  });

  test("breaker open longer than 5 minutes alerts", async () => {
    execute.mockResolvedValue(breakerRow("open", 5 * MINUTE + 1000));
    for (let i = 0; i < 3; i++) await breakerCheck("dataforseo");
    expect(ofKind("jobs-breaker-open")).toEqual([
      {
        kind: "jobs-breaker-open",
        payload: { provider: "dataforseo", account: "default", open_minutes: 5 },
      },
    ]);
  });

  test("a breaker open for less than 5 minutes, or closed, does not alert", async () => {
    execute.mockResolvedValue(breakerRow("open", 4 * MINUTE));
    await breakerCheck("dataforseo");
    execute.mockResolvedValue(breakerRow("closed", null));
    await breakerCheck("dataforseo");
    expect(alerts).toEqual([]);
  });

  test("handing out the probe is the move to half open", async () => {
    execute.mockResolvedValue(breakerRow("half_open", 30_000));
    await breakerCheck("openai");
    expect(events).toEqual([
      { name: "jobs.breaker.state", props: { provider: "openai", state: "half_open" } },
    ]);
  });
});

describe("saturation", () => {
  registerCapacitySource("dataforseo", {
    queuedSlots: async () => 200,
    p50LatencyMs: async () => 20_000,
  });

  beforeEach(() => execute.mockResolvedValue({ rows: [{ in_flight: 28 }] }));

  test("provider saturated more than 10 minutes alerts", async () => {
    guardModeSince.mockResolvedValue(new Date(Date.now() - 10 * MINUTE - 1000));
    await providerCapacity("dataforseo");
    await providerCapacity("dataforseo");
    expect(guardModeSince).toHaveBeenCalledWith("jobs-saturated:dataforseo");
    expect(ofKind("jobs-provider-saturated")).toEqual([
      {
        kind: "jobs-provider-saturated",
        payload: { provider: "dataforseo", predicted_wait_ms: 142_857, saturated_minutes: 10 },
      },
    ]);
  });

  test("saturation shorter than 10 minutes does not alert", async () => {
    guardModeSince.mockResolvedValue(new Date(Date.now() - 9 * MINUTE));
    await providerCapacity("dataforseo");
    guardModeSince.mockResolvedValue(null);
    resetJobsTelemetryForTest();
    registerJobsTelemetry(sink);
    await providerCapacity("dataforseo");
    expect(alerts).toEqual([]);
  });
});

describe("reportStepError", () => {
  test("a 4th fatal step within 15 minutes alerts jobs-workflow-failures", async () => {
    for (let i = 0; i < 4; i++) {
      await reportStepError("w", "s", new SpendCapExceededError("global", new Date()));
    }
    expect(ofKind("jobs-workflow-failures")).toHaveLength(1);
    expect(ofKind("jobs-workflow-failures")[0]?.payload).toEqual({
      workflow: "w",
      step: "s",
      error: "SpendCapExceeded",
      window_minutes: 15,
    });
    expect(events.filter((e) => e.name === "jobs.step.fatal")).toHaveLength(4);
  });

  test("three fatal steps spread over more than 15 minutes do not alert", async () => {
    vi.useFakeTimers();
    try {
      for (let i = 0; i < 6; i++) {
        await reportStepError("w", "s", new ProviderRejectedError("openai", "invalid_key"));
        vi.advanceTimersByTime(5 * MINUTE + 1000);
      }
      expect(ofKind("jobs-workflow-failures")).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  test("a retryable failure is a retry event and never counts toward the alert", async () => {
    for (let i = 0; i < 5; i++) await reportStepError("daily", "x", new RateLimitedError(1000));
    await reportStepError("daily", "x", new TypeError("socket hang up"));
    await reportStepError("daily", "x", new AppError("service_unavailable"));
    expect(events.map((e) => e.name)).toEqual(Array(7).fill("jobs.step.retry"));
    expect(events.at(-2)?.props).toEqual({ workflow: "daily", step: "x", error: "TypeError" });
    expect(events.at(-1)?.props).toEqual({
      workflow: "daily",
      step: "x",
      error: "service_unavailable",
    });
    expect(takeTokens).not.toHaveBeenCalled();
    expect(alerts).toEqual([]);
  });

  test("a value that is not an Error is reported by its type, never its content", async () => {
    await reportStepError("daily", "x", "ana@example.com");
    expect(events).toEqual([
      { name: "jobs.step.retry", props: { workflow: "daily", step: "x", error: "unknown" } },
    ]);
  });
});

describe("the sink", () => {
  test("without a sink nothing is emitted and no extra statement runs", async () => {
    registerJobsTelemetry(null);
    await simulateReservations({ cap: 1_000_000, amounts: [900_000, 200_000] });
    await reportStepError("w", "s", new SpendCapExceededError("global", new Date()));
    expect(execute).toHaveBeenCalledTimes(2);
    expect(takeTokens).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  test("a sink that throws never reaches the caller", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    registerJobsTelemetry({
      capture: () => {
        throw new Error("capture down");
      },
      alert: async () => {
        throw new Error("alert down");
      },
    });
    await expect(
      simulateReservations({ cap: 1_000_000, amounts: [900_000, 200_000] }),
    ).resolves.toBeUndefined();
    await expect(
      reportStepError("w", "s", new SpendCapExceededError("global", new Date())),
    ).resolves.toBeUndefined();
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  test("a failing alert dedupe never reaches the caller", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    takeTokens.mockRejectedValueOnce(new Error("db down"));
    await expect(
      simulateReservations({ cap: 1_000_000, amounts: [900_000] }),
    ).resolves.toBeUndefined();
    expect(alerts).toEqual([]);
    takeTokens.mockRejectedValueOnce(new Error("db down"));
    await expect(
      reportStepError("w", "s", new SpendCapExceededError("global", new Date())),
    ).resolves.toBeUndefined();
    guardModeSince.mockRejectedValueOnce(new Error("db down"));
    execute.mockResolvedValue({ rows: [{ in_flight: 28 }] });
    await expect(providerCapacity("dataforseo")).resolves.toMatchObject({
      predictedWaitMs: 142_857,
    });
    expect(alerts).toEqual([]);
    expect(error).toHaveBeenCalledTimes(3);
    error.mockRestore();
  });

  test("events carry no personal data and match the catalog exactly", async () => {
    await simulateReservations({ cap: 1_000_000, amounts: [700_000, 400_000] });
    execute.mockResolvedValue({
      rows: [{ state: "half_open", retry_after_ms: 0, opened_at: new Date() }],
    });
    await breakerCheck("dataforseo");
    await reportStepError("daily", "reconcileSpend", new RateLimitedError(1000));
    await reportStepError("job", "report.email", new SpendCapExceededError("global", new Date()));
    expect(new Set(events.map((e) => e.name)).size).toBe(5);
    for (const event of events) {
      expect(scrub(event.props)).toEqual(event.props);
      expect(sanitizeServerProps(event.name, event.props)).toEqual({
        props: event.props,
        dropped: [],
      });
    }
    for (const alert of alerts) expect(scrub(alert.payload)).toEqual(alert.payload);
  });
});
