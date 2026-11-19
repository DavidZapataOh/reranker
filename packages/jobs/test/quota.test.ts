import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const execute = vi.fn();
const withSystem = vi.fn(async (_reason: string, fn: (tx: unknown) => unknown) => fn({ execute }));
vi.mock("@reranker/db", () => ({ withSystem }));
// Quotas read the job config, which needs to know the environment.
vi.stubEnv("APP_ENV", "development");

const { InvalidInputError, QuotaExceededError } = await import("../src/errors");
const { consumeQuota, quotaStatus } = await import("../src/quota");

beforeEach(() => {
  execute.mockReset();
  withSystem.mockClear();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-16T17:24:05Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

describe("consumeQuota", () => {
  test("takes from the hour's counter in one statement", async () => {
    execute.mockResolvedValue({ rows: [{ ok: true }] });
    await consumeQuota("resend.emails", { priority: "high", amount: 2 });
    expect(withSystem.mock.calls[0]?.[0]).toBe("jobs.quota");
    expect(execute).toHaveBeenCalledTimes(1);
  });

  test("sends issued together share one transaction and each gets its own decision", async () => {
    execute.mockResolvedValue({ rows: [{ ok: true }, { ok: false }, { ok: true }] });
    const results = await Promise.allSettled([
      consumeQuota("resend.emails", { priority: "critical" }),
      consumeQuota("resend.emails", { priority: "low" }),
      consumeQuota("resend.emails", { priority: "normal", amount: 3 }),
    ]);
    expect(withSystem).toHaveBeenCalledTimes(1);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected", "fulfilled"]);
    expect((results[1] as PromiseRejectedResult).reason).toMatchObject({
      name: "QuotaExceeded",
      priority: "low",
    });
  });

  test("a send that arrives while a batch runs is decided in the next one", async () => {
    let commit = () => {};
    execute.mockImplementationOnce(
      () => new Promise((resolve) => (commit = () => resolve({ rows: [{ ok: true }] }))),
    );
    execute.mockResolvedValueOnce({ rows: [{ ok: true }, { ok: true }] });
    const first = consumeQuota("resend.emails", { priority: "high" });
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    const later = [
      consumeQuota("resend.emails", { priority: "high" }),
      consumeQuota("resend.emails", { priority: "high" }),
    ];
    commit();
    await Promise.all([first, ...later]);
    expect(withSystem).toHaveBeenCalledTimes(2);
  });

  test("a batch past 1,000 sends is split", async () => {
    execute.mockImplementation(async () => ({
      rows: Array.from({ length: 1_000 }, () => ({ ok: true })),
    }));
    await Promise.all(
      Array.from({ length: 1_001 }, () => consumeQuota("resend.emails", { priority: "high" })),
    );
    expect(withSystem).toHaveBeenCalledTimes(2);
  });

  test("sends in different hours never share a batch", async () => {
    execute.mockResolvedValue({ rows: [{ ok: true }] });
    vi.setSystemTime(new Date("2026-11-16T17:59:59.999Z"));
    const before = consumeQuota("resend.emails", { priority: "high" });
    vi.setSystemTime(new Date("2026-11-16T18:00:00Z"));
    await Promise.all([before, consumeQuota("resend.emails", { priority: "high" })]);
    expect(withSystem).toHaveBeenCalledTimes(2);
  });

  test("a failed batch rejects each of its sends with the failure, and the next send starts over", async () => {
    const failure = new Error("connection reset");
    execute.mockRejectedValueOnce(failure);
    const results = await Promise.allSettled([
      consumeQuota("resend.emails", { priority: "high" }),
      consumeQuota("resend.emails", { priority: "high" }),
    ]);
    expect(results).toEqual([
      { status: "rejected", reason: failure },
      { status: "rejected", reason: failure },
    ]);
    execute.mockResolvedValueOnce({ rows: [{ ok: true }] });
    await consumeQuota("resend.emails", { priority: "high" });
    expect(withSystem).toHaveBeenCalledTimes(2);
  });

  test("a refusal is QuotaExceeded until the next hour starts", async () => {
    execute.mockResolvedValue({ rows: [{ ok: false }] });
    const error = await consumeQuota("resend.emails", { priority: "low" }).catch((e) => e);
    expect(error).toBeInstanceOf(QuotaExceededError);
    expect(error).toMatchObject({
      quota: "resend.emails",
      priority: "low",
      resetsAt: new Date("2026-11-16T18:00:00Z"),
    });
  });

  test.each([
    ["an unknown quota", "x", { priority: "low" }],
    ["an inherited key", "toString", { priority: "low" }],
    ["an unknown priority", "resend.emails", { priority: "urgent" }],
    ["a zero amount", "resend.emails", { priority: "low", amount: 0 }],
    ["a fractional amount", "resend.emails", { priority: "low", amount: 1.5 }],
    ["an amount past int", "resend.emails", { priority: "low", amount: 2 ** 31 }],
  ])("%s is invalid before any statement", async (_label, name, opts) => {
    await expect(
      consumeQuota(name, opts as Parameters<typeof consumeQuota>[1]),
    ).rejects.toBeInstanceOf(InvalidInputError);
    expect(execute).not.toHaveBeenCalled();
  });
});

describe("quotaStatus", () => {
  test("reports the hour's sends against each class's share of its limit", async () => {
    execute.mockResolvedValue({ rows: [{ used: 412, hour_limit: 1_205 }] });
    await expect(quotaStatus("resend.emails")).resolves.toEqual({
      critical: { used: 412, limit: 1_205 },
      high: { used: 412, limit: 1_205 },
      normal: { used: 412, limit: 964 },
      low: { used: 412, limit: 120 },
    });
  });

  test("an unknown quota is invalid", () =>
    expect(quotaStatus("x")).rejects.toBeInstanceOf(InvalidInputError));
});
