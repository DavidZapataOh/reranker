import { AppError } from "@reranker/schema";
import { beforeEach, describe, expect, test, vi } from "vitest";

const execute = vi.fn();
const withSystem = vi.fn(async (_reason: string, fn: (tx: unknown) => unknown) => fn({ execute }));
vi.mock("@reranker/db", async () => ({
  withSystem,
  isCheckoutTimeout: (await import("../../db/src/errors")).isCheckoutTimeout,
}));

vi.stubEnv("APP_ENV", "development");
const { breakerCheck, breakerRecord } = await import("../src/breaker");
const { registerJobsTelemetry, resetJobsTelemetryForTest } = await import("../src/telemetry");

const events: unknown[] = [];

beforeEach(() => {
  execute.mockReset();
  withSystem.mockClear();
  events.length = 0;
  resetJobsTelemetryForTest();
  registerJobsTelemetry({ capture: (event) => void events.push(event), alert: async () => {} });
});

describe("breakerCheck", () => {
  test("is one system statement and maps the row", async () => {
    execute.mockResolvedValue({
      rows: [{ state: "open", retry_after_ms: 28_000, opened_at: new Date() }],
    });
    await expect(breakerCheck("dataforseo")).resolves.toEqual({
      state: "open",
      retryAfterMs: 28_000,
    });
    expect(withSystem).toHaveBeenCalledTimes(1);
    expect(withSystem.mock.calls[0]?.[0]).toBe("jobs.breaker");
    expect(execute).toHaveBeenCalledTimes(1);
  });

  test("fails loudly when the function returns nothing", async () => {
    execute.mockResolvedValue({ rows: [] });
    await expect(breakerCheck("dataforseo", "main")).rejects.toThrow("no row");
  });
});

describe("breakerRecord", () => {
  test.each(["success", "failure"] as const)("is one system statement for %s", async (outcome) => {
    execute.mockResolvedValue({ rows: [{ state: "closed", previous: "closed" }] });
    await breakerRecord("openai", outcome);
    expect(withSystem).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  test("outcomes arriving while a record is in flight go together in the next one", async () => {
    let release = () => {};
    execute.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ rows: [{ state: "closed", previous: "closed" }] });
        }),
    );
    execute.mockResolvedValue({ rows: [{ state: "closed", previous: "closed" }] });
    const first = breakerRecord("dataforseo", "success");
    const rest = [
      ...Array.from({ length: 6 }, () => breakerRecord("dataforseo", "success")),
      ...Array.from({ length: 3 }, () => breakerRecord("dataforseo", "failure")),
    ];
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    release();
    await Promise.all([first, ...rest]);
    expect(withSystem).toHaveBeenCalledTimes(2);
    // provider, account, successes, failures, then the configured thresholds.
    const counts = execute.mock.calls.map(([query]) =>
      (query as { queryChunks: unknown[] }).queryChunks
        .filter((chunk) => typeof chunk !== "object")
        .slice(0, 4),
    );
    expect(counts).toEqual([
      ["dataforseo", "default", 1, 0],
      ["dataforseo", "default", 6, 3],
    ]);
  });

  const checkoutTimeout = () =>
    new AppError("service_unavailable", {
      retryAfterSeconds: 2,
      cause: new Error("timeout exceeded when trying to connect"),
    });

  test("outcomes whose checkout timed out are recorded again with those that arrived meanwhile", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    execute.mockImplementationOnce(async () => {
      void breakerRecord("dataforseo", "failure");
      throw checkoutTimeout();
    });
    execute.mockResolvedValue({ rows: [{ state: "closed", previous: "closed" }] });
    await breakerRecord("dataforseo", "failure");
    const counts = execute.mock.calls.map(([query]) =>
      (query as { queryChunks: unknown[] }).queryChunks
        .filter((chunk) => typeof chunk !== "object")
        .slice(0, 4),
    );
    expect(counts).toEqual([
      ["dataforseo", "default", 0, 1],
      ["dataforseo", "default", 0, 2],
    ]);
    expect(logged).not.toHaveBeenCalled();
    logged.mockRestore();
  });

  test("gives outcomes up with a log once they have waited 10 s for a connection", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const now = vi.spyOn(performance, "now").mockReturnValue(1_000);
    execute.mockImplementation(async () => {
      now.mockReturnValue(11_000);
      throw checkoutTimeout();
    });
    await expect(breakerRecord("dataforseo", "failure")).resolves.toBeUndefined();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(logged).toHaveBeenCalledWith("[jobs] breaker record (dataforseo) failed", {
      name: "AppError",
    });
    now.mockRestore();
    logged.mockRestore();
  });

  test("another breaker is recorded on its own, never behind this one", async () => {
    execute.mockImplementationOnce(() => new Promise(() => {}));
    execute.mockResolvedValue({ rows: [{ state: "closed", previous: "closed" }] });
    void breakerRecord("gemini", "success", "stalled");
    await expect(breakerRecord("gemini", "success", "other")).resolves.toBeUndefined();
  });

  test.each([
    ["closed", "open"],
    ["half_open", "open"],
    ["half_open", "closed"],
  ])("a move from %s to %s is a state event", async (previous, state) => {
    execute.mockResolvedValue({ rows: [{ state, previous }] });
    await breakerRecord("dataforseo", "failure");
    expect(events).toEqual([
      { name: "jobs.breaker.state", props: { provider: "dataforseo", state } },
    ]);
  });

  test.each(["closed", "open"])("staying %s emits nothing", async (state) => {
    execute.mockResolvedValue({ rows: [{ state, previous: state }] });
    await breakerRecord("dataforseo", "success");
    expect(events).toEqual([]);
  });

  test.each([
    ["the function returns nothing", () => execute.mockResolvedValue({ rows: [] })],
    ["the database is unreachable", () => execute.mockRejectedValue(new Error("pool timeout"))],
  ])("logs and never throws when %s, so a paid call is never failed by it", async (_, fail) => {
    fail();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(breakerRecord("openai", "success")).resolves.toBeUndefined();
    expect(logged).toHaveBeenCalledWith("[jobs] breaker record (openai) failed", {
      name: "Error",
    });
    logged.mockRestore();
  });
});
