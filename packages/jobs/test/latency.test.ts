import { cost } from "@reranker/schema";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { InvalidInputError, RateLimitedError, SpendCapExceededError } from "../src/errors";

vi.stubEnv("APP_ENV", "development");

const calls = vi.hoisted(() => [] as string[]);
const mocks = vi.hoisted(() => ({
  acquireProviderSlot: vi.fn(),
  reserveSpend: vi.fn(),
  settleSpend: vi.fn(),
}));
vi.mock("../src/leases", () => ({ acquireProviderSlot: mocks.acquireProviderSlot }));
vi.mock("../src/spend", () => ({
  reserveSpend: mocks.reserveSpend,
  settleSpend: mocks.settleSpend,
}));

const { probeSpendPath, summarize } = await import("../src/latency");

const reservation = { id: "0190e8c4-0000-7000-8000-000000000000" };

beforeEach(() => {
  calls.length = 0;
  mocks.acquireProviderSlot.mockReset().mockImplementation(async () => {
    calls.push("acquire");
    return { release: async () => void calls.push("release") };
  });
  mocks.reserveSpend.mockReset().mockImplementation(async () => {
    calls.push("reserve");
    return reservation;
  });
  mocks.settleSpend.mockReset().mockImplementation(async () => {
    calls.push("settle");
    return { applied: true };
  });
});

describe("summarize", () => {
  test("gives nearest-rank percentiles in milliseconds", () => {
    const samples = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(summarize(samples)).toEqual({ p50: 50, p95: 95, n: 100 });
  });

  test("does not depend on the order samples arrive in", () => {
    expect(summarize([9, 1, 5])).toEqual({ p50: 5, p95: 9, n: 3 });
  });

  test("rounds to hundredths of a millisecond", () => {
    expect(summarize([1.23456])).toEqual({ p50: 1.23, p95: 1.23, n: 1 });
  });
});

describe("probeSpendPath", () => {
  test("times each primitive of the spend path, n times in order", async () => {
    const report = await probeSpendPath(3);
    expect(calls).toEqual(Array(3).fill(["acquire", "reserve", "settle", "release"]).flat());
    for (const name of ["acquireProviderSlot", "reserveSpend", "settleSpend"] as const) {
      expect(report[name].n).toBe(3);
      expect(report[name].p95).toBeGreaterThanOrEqual(report[name].p50);
    }
  });

  test("uses a DataForSEO account of its own and spends nothing", async () => {
    await probeSpendPath(1);
    const [provider, limits] = mocks.acquireProviderSlot.mock.calls[0] ?? [];
    expect(provider).toBe("dataforseo");
    expect(limits).toMatchObject({ maxInFlight: 28, rpm: 9000, account: "latency-probe" });
    expect(mocks.reserveSpend).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "dataforseo",
        purpose: "contract-test",
        refType: "latency-probe",
        estimate: cost(1, "USD"),
      }),
    );
    expect(mocks.settleSpend).toHaveBeenCalledWith(reservation, cost(0, "USD"));
  });

  test("holds the slot for holdMs, standing in for the provider call", async () => {
    vi.useFakeTimers();
    try {
      const done = probeSpendPath(1, { holdMs: 500 });
      await vi.advanceTimersByTimeAsync(499);
      expect(calls).not.toContain("settle");
      await vi.advanceTimersByTimeAsync(1);
      await done;
      expect(calls).toEqual(["acquire", "reserve", "settle", "release"]);
    } finally {
      vi.useRealTimers();
    }
  });

  test("a denied slot stops the probe with the typed error", async () => {
    mocks.acquireProviderSlot.mockRejectedValueOnce(new RateLimitedError(1200));
    await expect(probeSpendPath(2)).rejects.toBeInstanceOf(RateLimitedError);
    expect(mocks.reserveSpend).not.toHaveBeenCalled();
  });

  test("gives the slot back when the reservation is denied", async () => {
    mocks.reserveSpend.mockRejectedValueOnce(
      new SpendCapExceededError("purpose:contract-test", new Date()),
    );
    await expect(probeSpendPath(1)).rejects.toBeInstanceOf(SpendCapExceededError);
    expect(calls).toEqual(["acquire", "release"]);
  });

  test.each([0, -1, 1.5, 1001, Number.NaN])("refuses %s calls", async (n) => {
    await expect(probeSpendPath(n)).rejects.toBeInstanceOf(InvalidInputError);
    expect(mocks.acquireProviderSlot).not.toHaveBeenCalled();
  });

  test.each([-1, 2001, 0.5])("refuses a hold of %s ms", async (holdMs) => {
    await expect(probeSpendPath(1, { holdMs })).rejects.toBeInstanceOf(InvalidInputError);
  });
});
