import { AppError } from "@reranker/schema";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const execute = vi.fn();
const withSystem = vi.fn(async (_reason: string, fn: (tx: unknown) => unknown, _opts?: unknown) =>
  fn({ execute }),
);
vi.mock("@reranker/db", () => ({ withSystem }));
const breakerCheck = vi.fn();
vi.mock("../src/breaker", () => ({ breakerCheck }));

vi.stubEnv("APP_ENV", "development");
const { InvalidInputError, ProviderUnavailableError, RateLimitedError } = await import(
  "../src/errors"
);
const { acquireProviderSlot } = await import("../src/leases");
const { registerJobsTelemetry } = await import("../src/telemetry");
const events: unknown[] = [];
registerJobsTelemetry({ capture: (event) => void events.push(event), alert: async () => {} });

const lease = (n: number) => `0194f5c0-0000-7000-8000-${String(n).padStart(12, "0")}`;
const LEASE = lease(1);
const grants = (...ids: string[]) => ({
  rows: ids.map((id) => ({ lease_id: id, retry_after_ms: 0 })),
});
const granted = grants(LEASE);
const denied = (ms: number) => ({ rows: [{ lease_id: null, retry_after_ms: ms }] });

// What each transaction asked for: how many callers, and which leases it released.
const dialect = new PgDialect();
const asked = () =>
  execute.mock.calls.map(([query]) => {
    const params = dialect.sqlToQuery(query as SQL).params;
    return { count: params[3], released: params[4], costs: params[8] };
  });

// Pools live for the process, so each test takes an account of its own.
let accounts = 0;
const limits = (maxInFlight: number, extra: { rpm?: number; tpm?: number } = {}) => ({
  maxInFlight,
  account: `unit-${++accounts}`,
  ...extra,
});

function pending() {
  let answer: (value: unknown) => void = () => {};
  execute.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        answer = resolve;
      }),
  );
  return (value: unknown) => answer(value);
}

beforeEach(() => {
  vi.useFakeTimers();
  events.length = 0;
  execute.mockReset();
  withSystem.mockClear();
  breakerCheck.mockReset().mockResolvedValue({ state: "closed", retryAfterMs: 0 });
});
afterEach(() => vi.useRealTimers());

describe("acquireProviderSlot", () => {
  test("checks the breaker for the whole lease before taking a slot", async () => {
    execute.mockResolvedValue(granted);
    await acquireProviderSlot("dataforseo", { maxInFlight: 28, account: "main" });
    expect(breakerCheck).toHaveBeenCalledWith("dataforseo", "main", 130_000);
    expect(withSystem.mock.calls[0]?.[0]).toBe("jobs.lease");
  });

  test("an open breaker throws before any statement runs", async () => {
    breakerCheck.mockResolvedValue({ state: "open", retryAfterMs: 12_000 });
    const error = await acquireProviderSlot("openai", limits(10)).catch((e) => e);
    expect(error).toBeInstanceOf(ProviderUnavailableError);
    expect(error.retryAfterMs).toBe(12_000);
    expect(execute).not.toHaveBeenCalled();
  });

  test("half open passes: the caller is the probe", async () => {
    breakerCheck.mockResolvedValue({ state: "half_open", retryAfterMs: 0 });
    execute.mockResolvedValue(granted);
    await expect(acquireProviderSlot("openai", limits(10))).resolves.toBeDefined();
  });

  test("polls until the deadline, then reports the last retry hint", async () => {
    execute.mockResolvedValue(denied(90_000));
    const result = acquireProviderSlot("dataforseo", limits(28), { maxWaitMs: 3000 }).catch(
      (e) => e,
    );
    await vi.advanceTimersByTimeAsync(3000);
    const error = await result;
    expect(error).toBeInstanceOf(RateLimitedError);
    expect(error.retryAfterMs).toBe(90_000);
    expect(execute.mock.calls.length).toBeGreaterThan(3);
    expect(events).toEqual([{ name: "jobs.lease.denied", props: { provider: "dataforseo" } }]);
  });

  test("each attempt waits for the pool row no longer than the caller has left", async () => {
    execute.mockResolvedValue(denied(1000));
    const result = acquireProviderSlot("dataforseo", limits(28), { maxWaitMs: 3000 }).catch(
      (e) => e,
    );
    await vi.advanceTimersByTimeAsync(3000);
    await result;
    const waits = withSystem.mock.calls.map(
      (call) => (call[2] as { lockTimeoutMs: number }).lockTimeoutMs,
    );
    expect(waits[0]).toBe(2000);
    expect(waits.at(-1)).toBeLessThanOrEqual(1000);
    expect(waits.every((ms) => ms >= 1)).toBe(true);
  });

  test("a pool row still locked when the wait runs out is a full pool", async () => {
    const lockTimeout = new AppError("timeout", {
      cause: Object.assign(new Error(), { code: "55P03" }),
    });
    execute.mockRejectedValue(lockTimeout);
    const result = acquireProviderSlot("dataforseo", limits(1), { maxWaitMs: 0 }).catch((e) => e);
    await vi.advanceTimersByTimeAsync(0);
    const error = await result;
    expect(error).toBeInstanceOf(RateLimitedError);
    expect(error.retryAfterMs).toBe(1000);
    expect(withSystem.mock.calls[0]?.[2]).toEqual({ lockTimeoutMs: 1 });
  });

  test("a statement timeout is not taken for a full pool", async () => {
    const statementTimeout = new AppError("timeout", {
      cause: Object.assign(new Error(), { code: "57014" }),
    });
    execute.mockRejectedValue(statementTimeout);
    await expect(acquireProviderSlot("dataforseo", limits(1), { maxWaitMs: 0 })).rejects.toBe(
      statementTimeout,
    );
  });

  test("a zero wait tries once", async () => {
    execute.mockResolvedValue(denied(5000));
    const result = acquireProviderSlot("dataforseo", limits(1), { maxWaitMs: 0 }).catch((e) => e);
    await vi.advanceTimersByTimeAsync(0);
    expect(await result).toBeInstanceOf(RateLimitedError);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  test("defaults the wait to the inline limit of the config", async () => {
    execute.mockResolvedValue(denied(1000));
    const result = acquireProviderSlot("dataforseo", limits(1)).catch((e) => e);
    await vi.advanceTimersByTimeAsync(4999);
    expect(await Promise.race([result, "pending"])).toBe("pending");
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toBeInstanceOf(RateLimitedError);
  });

  test("takes the slot the moment it frees and reports the wait", async () => {
    execute.mockResolvedValueOnce(denied(60_000)).mockResolvedValue(granted);
    const result = acquireProviderSlot("dataforseo", limits(1), { maxWaitMs: 5000 });
    await vi.advanceTimersByTimeAsync(1000);
    await result;
    expect(events).toEqual([
      {
        name: "jobs.lease.wait_ms",
        props: { provider: "dataforseo", wait_ms: expect.any(Number) },
      },
    ]);
  });

  test("callers arriving while a transaction runs are granted together by the next one", async () => {
    const pool = limits(28);
    const answer = pending();
    execute.mockResolvedValueOnce(granted).mockResolvedValue(grants(lease(2), lease(3), lease(4)));
    const first = acquireProviderSlot("dataforseo", pool, { maxWaitMs: 5000 });
    await vi.advanceTimersByTimeAsync(0);
    const later = [1, 2, 3].map(() => acquireProviderSlot("dataforseo", pool, { maxWaitMs: 5000 }));
    const otherPool = acquireProviderSlot("openai", limits(10), { maxWaitMs: 5000 });
    await vi.advanceTimersByTimeAsync(100);
    await otherPool;
    expect(execute).toHaveBeenCalledTimes(2);
    answer(granted);
    await Promise.all([first, ...later]);
    expect(asked().map((a) => a.count)).toEqual([1, 1, 3]);
  });

  test("a transaction asks for no more callers than the pool holds", async () => {
    const pool = limits(2);
    execute.mockResolvedValue(grants(lease(1), lease(2)));
    const callers = [1, 2, 3, 4, 5].map(() =>
      acquireProviderSlot("dataforseo", pool, { maxWaitMs: 5000 }),
    );
    await vi.advanceTimersByTimeAsync(0);
    await Promise.all(callers);
    expect(asked().map((a) => a.count)).toEqual([2, 2, 1]);
  });

  test("a full pool grants the callers it can, in priority order, and the rest keep waiting", async () => {
    const pool = limits(28);
    const answer = pending();
    const order: string[] = [];
    const first = acquireProviderSlot("dataforseo", pool, { maxWaitMs: 5000 });
    await vi.advanceTimersByTimeAsync(0);
    const take = (name: string, priority: "low" | "normal" | "high") =>
      acquireProviderSlot("dataforseo", pool, { maxWaitMs: 5000, priority }).then(() => {
        order.push(name);
      });
    const low = take("low", "low");
    const normal = take("normal", "normal");
    const high = take("high", "high");
    await vi.advanceTimersByTimeAsync(0);
    execute
      .mockResolvedValueOnce({
        rows: [{ lease_id: lease(2), retry_after_ms: 0 }, denied(800).rows[0]],
      })
      .mockResolvedValue(grants(lease(3), lease(4)));
    answer(granted);
    await first;
    await vi.advanceTimersByTimeAsync(0);
    expect(order).toEqual(["high"]);
    await vi.advanceTimersByTimeAsync(1000);
    await Promise.all([low, normal, high]);
    expect(order).toEqual(["high", "normal", "low"]);
  });

  test("an unknown priority is invalid input", async () => {
    await expect(
      acquireProviderSlot("dataforseo", limits(1), { priority: "urgent" as never }),
    ).rejects.toBeInstanceOf(InvalidInputError);
  });

  test("an acquirer whose wait runs out before its turn is a full pool, without a statement", async () => {
    const pool = limits(28);
    const answer = pending();
    const first = acquireProviderSlot("dataforseo", pool, { maxWaitMs: 5000 });
    await vi.advanceTimersByTimeAsync(0);
    const late = acquireProviderSlot("dataforseo", pool, { maxWaitMs: 300 }).catch((e) => e);
    await vi.advanceTimersByTimeAsync(300);
    const error = await late;
    expect(error).toBeInstanceOf(RateLimitedError);
    expect(error.retryAfterMs).toBe(1000);
    expect(execute).toHaveBeenCalledTimes(1);
    answer(granted);
    await first;
  });

  test("a caller whose wait runs out during its transaction still gets the slot granted", async () => {
    const answer = pending();
    const slot = acquireProviderSlot("dataforseo", limits(1), { maxWaitMs: 100 });
    await vi.advanceTimersByTimeAsync(500);
    answer(granted);
    await expect(slot).resolves.toBeDefined();
  });

  test("fails loudly when the function returns nothing", async () => {
    execute.mockResolvedValue({ rows: [] });
    await expect(acquireProviderSlot("dataforseo", limits(1))).rejects.toThrow("no row");
  });

  test("a cost above the rate limit can never pass and is invalid input", async () => {
    await expect(
      acquireProviderSlot("openai", limits(1, { tpm: 100 }), { cost: { tokens: 101 } }),
    ).rejects.toBeInstanceOf(InvalidInputError);
    expect(execute).not.toHaveBeenCalled();
  });

  test("each caller's cost goes to every bucket of the pool, zero tokens when it gave none", async () => {
    const pool = limits(5, { rpm: 60, tpm: 1000 });
    execute.mockResolvedValue(grants(lease(1), lease(2)));
    await Promise.all([
      acquireProviderSlot("openai", pool, { cost: { requests: 1, tokens: 300 } }),
      acquireProviderSlot("openai", pool),
    ]);
    expect(asked()).toEqual([{ count: 2, released: [], costs: [1, 300, 1, 0] }]);
  });

  test("a raw address is not a valid account", async () => {
    await expect(
      acquireProviderSlot("openai", { maxInFlight: 1, account: "203.0.113.7" }),
    ).rejects.toBeInstanceOf(InvalidInputError);
  });

  test("release deletes the lease once", async () => {
    execute.mockResolvedValue(granted);
    const slot = await acquireProviderSlot("dataforseo", limits(1));
    execute.mockClear();
    await slot.release();
    await slot.release();
    expect(asked()).toEqual([{ count: 0, released: [LEASE], costs: [] }]);
  });

  test("releases go out with the next grant, and a release wakes the callers waiting for it", async () => {
    const pool = limits(1);
    execute.mockResolvedValueOnce(granted).mockResolvedValueOnce(denied(60_000));
    const held = await acquireProviderSlot("dataforseo", pool);
    const waiting = acquireProviderSlot("dataforseo", pool, { maxWaitMs: 5000 });
    await vi.advanceTimersByTimeAsync(0);
    execute.mockResolvedValue(grants(lease(2)));
    // Well before the first backoff ends.
    const released = held.release();
    await vi.advanceTimersByTimeAsync(0);
    await Promise.all([released, waiting]);
    expect(asked().slice(1)).toEqual([
      { count: 1, released: [], costs: [] },
      { count: 1, released: [LEASE], costs: [] },
    ]);
  });

  test("a release refused by a locked pool row goes out again with the next transaction", async () => {
    const pool = limits(1);
    execute.mockResolvedValueOnce(granted);
    const held = await acquireProviderSlot("dataforseo", pool);
    const answer = pending();
    const waiting = acquireProviderSlot("dataforseo", pool, { maxWaitMs: 5000 });
    await vi.advanceTimersByTimeAsync(0);
    const released = held.release();
    execute
      .mockRejectedValueOnce(
        new AppError("timeout", { cause: Object.assign(new Error(), { code: "55P03" }) }),
      )
      .mockResolvedValue(grants(lease(2)));
    answer(denied(60_000));
    await vi.advanceTimersByTimeAsync(0);
    await Promise.all([released, waiting]);
    expect(asked().slice(1)).toEqual([
      { count: 1, released: [], costs: [] },
      { count: 1, released: [LEASE], costs: [] },
      { count: 1, released: [LEASE], costs: [] },
    ]);
  });

  test("a failed release does not throw", async () => {
    execute.mockResolvedValueOnce(granted);
    const slot = await acquireProviderSlot("dataforseo", limits(1));
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    execute.mockRejectedValueOnce(Object.assign(new Error("down"), { code: "08006" }));
    await expect(slot.release()).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith("[jobs] lease release failed", { code: "08006" });
    log.mockRestore();
  });
});
