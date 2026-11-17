import { AppError } from "@reranker/schema";
import { beforeEach, describe, expect, test, vi } from "vitest";

const execute = vi.fn();
const withSystem = vi.fn(async (_reason: string, fn: (tx: unknown) => unknown) => fn({ execute }));
vi.mock("@reranker/db", () => ({ withSystem }));

const { InvalidInputError } = await import("../src/errors");
const { guardModeSince, guardModeStatus, tripGuardMode } = await import("../src/guard-mode");

const until = new Date("2026-11-16T12:00:00Z");

beforeEach(() => {
  execute.mockReset();
  withSystem.mockClear();
});

describe("tripGuardMode", () => {
  test("is one system statement and maps the row", async () => {
    execute.mockResolvedValue({ rows: [{ active_until: until, newly_tripped: true }] });
    await expect(tripGuardMode("free-report-verify", "spike", 60_000)).resolves.toEqual({
      active: true,
      activeUntil: until,
      newlyTripped: true,
    });
    expect(withSystem.mock.calls[0]?.[0]).toBe("jobs.guard-mode");
    expect(execute).toHaveBeenCalledTimes(1);
  });

  test("reads a timestamp the driver left as text", async () => {
    execute.mockResolvedValue({
      rows: [{ active_until: until.toISOString(), newly_tripped: false }],
    });
    expect((await tripGuardMode("x", "spike", 1)).activeUntil).toEqual(until);
  });

  test("fails loudly when the function returns nothing", async () => {
    execute.mockResolvedValue({ rows: [] });
    await expect(tripGuardMode("x", "spike", 1)).rejects.toThrow("no row");
  });

  test.each([
    ["", "spike", 1_000],
    ["bad name!", "spike", 1_000],
    ["x", "  ", 1_000],
    ["x", "spike", 0],
    ["x", "spike", -5],
    ["x", "spike", 1.5],
    ["x", "spike", 2 ** 31],
  ])("rejects %j %j %j before any statement", async (name, reason, hold) => {
    await expect(tripGuardMode(name, reason, hold)).rejects.toBeInstanceOf(InvalidInputError);
    expect(execute).not.toHaveBeenCalled();
  });

  test("maps a rejected parameter (22023) to invalid input and lets other failures through", async () => {
    execute.mockRejectedValue(new AppError("internal", { cause: { code: "22023" } }));
    await expect(tripGuardMode("x", "spike", 1)).rejects.toBeInstanceOf(InvalidInputError);
    execute.mockRejectedValue(new Error("boom"));
    await expect(tripGuardMode("x", "spike", 1)).rejects.toThrow("boom");
  });
});

describe("guardModeStatus", () => {
  test("maps an active mode", async () => {
    execute.mockResolvedValue({
      rows: [{ active: true, active_until: until, reason: "spike", released_now: false }],
    });
    await expect(guardModeStatus("x")).resolves.toEqual({
      active: true,
      activeUntil: until,
      reason: "spike",
      releasedNow: false,
    });
  });

  test("maps a mode that was never tripped", async () => {
    execute.mockResolvedValue({
      rows: [{ active: false, active_until: null, reason: null, released_now: false }],
    });
    await expect(guardModeStatus("x")).resolves.toEqual({
      active: false,
      activeUntil: null,
      reason: null,
      releasedNow: false,
    });
  });

  test("fails loudly when the function returns nothing and rejects a bad name", async () => {
    execute.mockResolvedValue({ rows: [] });
    await expect(guardModeStatus("x")).rejects.toThrow("no row");
    await expect(guardModeStatus("bad name!")).rejects.toBeInstanceOf(InvalidInputError);
  });
});

describe("guardModeSince", () => {
  test("is one system statement: the trip time of an active mode, null when off", async () => {
    execute.mockResolvedValue({ rows: [{ tripped_at: until.toISOString() }] });
    await expect(guardModeSince("jobs-saturated:dataforseo")).resolves.toEqual(until);
    expect(execute).toHaveBeenCalledTimes(1);
    execute.mockResolvedValue({ rows: [] });
    await expect(guardModeSince("jobs-saturated:dataforseo")).resolves.toBeNull();
    await expect(guardModeSince("bad name!")).rejects.toBeInstanceOf(InvalidInputError);
  });
});
