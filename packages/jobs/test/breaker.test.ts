import { beforeEach, describe, expect, test, vi } from "vitest";

const execute = vi.fn();
const withSystem = vi.fn(async (_reason: string, fn: (tx: unknown) => unknown) => fn({ execute }));
vi.mock("@reranker/db", () => ({ withSystem }));

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
    expect(logged).toHaveBeenCalledWith("[jobs] breaker record (openai, success) failed", {
      name: "Error",
    });
    logged.mockRestore();
  });
});
