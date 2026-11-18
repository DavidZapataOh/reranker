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
