import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const execute = vi.fn();
const withSystem = vi.fn(async (_reason: string, fn: (tx: unknown) => unknown) => fn({ execute }));
vi.mock("@reranker/db", () => ({ withSystem }));
const breakerCheck = vi.fn();
vi.mock("../src/breaker", () => ({ breakerCheck }));

vi.stubEnv("APP_ENV", "development");
const { InvalidInputError, ProviderUnavailableError, RateLimitedError } = await import(
  "../src/errors"
);
const { acquireProviderSlot } = await import("../src/leases");

const LEASE = "0194f5c0-0000-7000-8000-000000000001";
const granted = { rows: [{ lease_id: LEASE, retry_after_ms: 0 }] };
const denied = (ms: number) => ({ rows: [{ lease_id: null, retry_after_ms: ms }] });

beforeEach(() => {
  vi.useFakeTimers();
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
    const error = await acquireProviderSlot("openai", { maxInFlight: 10 }).catch((e) => e);
    expect(error).toBeInstanceOf(ProviderUnavailableError);
    expect(error.retryAfterMs).toBe(12_000);
    expect(execute).not.toHaveBeenCalled();
  });

  test("half open passes: the caller is the probe", async () => {
    breakerCheck.mockResolvedValue({ state: "half_open", retryAfterMs: 0 });
    execute.mockResolvedValue(granted);
    await expect(acquireProviderSlot("openai", { maxInFlight: 10 })).resolves.toBeDefined();
  });

  test("polls until the deadline, then reports the last retry hint", async () => {
    execute.mockResolvedValue(denied(90_000));
    const events: unknown[] = [];
    const result = acquireProviderSlot(
      "dataforseo",
      { maxInFlight: 28 },
      { maxWaitMs: 3000, onEvent: (e) => events.push(e) },
    ).catch((e) => e);
    await vi.advanceTimersByTimeAsync(3000);
    const error = await result;
    expect(error).toBeInstanceOf(RateLimitedError);
    expect(error.retryAfterMs).toBe(90_000);
    expect(execute.mock.calls.length).toBeGreaterThan(3);
    expect(events).toEqual([{ name: "jobs.lease.denied", props: { provider: "dataforseo" } }]);
  });

  test("a zero wait tries once", async () => {
    execute.mockResolvedValue(denied(5000));
    await expect(
      acquireProviderSlot("dataforseo", { maxInFlight: 1 }, { maxWaitMs: 0 }),
    ).rejects.toBeInstanceOf(RateLimitedError);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  test("defaults the wait to the inline limit of the config", async () => {
    execute.mockResolvedValue(denied(1000));
    const result = acquireProviderSlot("dataforseo", { maxInFlight: 1 }).catch((e) => e);
    await vi.advanceTimersByTimeAsync(4999);
    expect(await Promise.race([result, "pending"])).toBe("pending");
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toBeInstanceOf(RateLimitedError);
  });

  test("takes the slot the moment it frees and reports the wait", async () => {
    execute.mockResolvedValueOnce(denied(60_000)).mockResolvedValue(granted);
    const events: unknown[] = [];
    const result = acquireProviderSlot(
      "dataforseo",
      { maxInFlight: 1 },
      { maxWaitMs: 5000, onEvent: (e) => events.push(e) },
    );
    await vi.advanceTimersByTimeAsync(1000);
    await result;
    expect(events).toEqual([
      {
        name: "jobs.lease.wait_ms",
        props: { provider: "dataforseo", wait_ms: expect.any(Number) },
      },
    ]);
  });

  test("fails loudly when the function returns nothing", async () => {
    execute.mockResolvedValue({ rows: [] });
    await expect(acquireProviderSlot("dataforseo", { maxInFlight: 1 })).rejects.toThrow("no row");
  });

  test("a cost above the rate limit can never pass and is invalid input", async () => {
    await expect(
      acquireProviderSlot("openai", { maxInFlight: 1, tpm: 100 }, { cost: { tokens: 101 } }),
    ).rejects.toBeInstanceOf(InvalidInputError);
    expect(execute).not.toHaveBeenCalled();
  });

  test("a raw address is not a valid account", async () => {
    await expect(
      acquireProviderSlot("openai", { maxInFlight: 1, account: "203.0.113.7" }),
    ).rejects.toBeInstanceOf(InvalidInputError);
  });

  test("release deletes the lease once", async () => {
    execute.mockResolvedValue(granted);
    const slot = await acquireProviderSlot("dataforseo", { maxInFlight: 1 });
    execute.mockClear();
    await slot.release();
    await slot.release();
    expect(execute).toHaveBeenCalledTimes(1);
  });

  test("a failed release does not throw", async () => {
    execute.mockResolvedValueOnce(granted);
    const slot = await acquireProviderSlot("dataforseo", { maxInFlight: 1 });
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    execute.mockRejectedValueOnce(Object.assign(new Error("down"), { code: "08006" }));
    await expect(slot.release()).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith("[jobs] lease release failed", { code: "08006" });
    log.mockRestore();
  });
});
