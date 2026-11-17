import { endPools } from "@reranker/db";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { nextResetAt } from "../src/day";
import { InvalidInputError, QuotaExceededError } from "../src/errors";
import { consumeQuota, quotaStatus } from "../src/quota";

// Quotas read the job config, which needs to know the environment.
vi.stubEnv("APP_ENV", "development");

// Concurrency is real only with more connections than the default three of the system pool.
beforeAll(() => {
  process.env.DB_POOL_MAX = "20";
});
afterAll(() => endPools());

// Every test runs on a day of its own, so its counters never meet another test's or another
// run's sharing the database. Noon in Bogota is 17:00Z.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const year = 2100 + Math.floor(Math.random() * 800);
  const dayOfYear = Math.floor(Math.random() * 365);
  vi.setSystemTime(new Date(Date.UTC(year, 0, 1 + dayOfYear, 17)));
});
afterEach(() => {
  vi.useRealTimers();
});

describe("consumeQuota", () => {
  test("fixed classes: 40 critical grant 30, then normal keeps 50 and high 16", async () => {
    const crit = await Promise.allSettled(
      Array.from({ length: 40 }, () => consumeQuota("resend.emails", { priority: "critical" })),
    );
    expect(crit.filter((r) => r.status === "fulfilled")).toHaveLength(30);
    const rejected = crit.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(QuotaExceededError);
    expect(rejected.reason).toMatchObject({
      name: "QuotaExceeded",
      quota: "resend.emails",
      priority: "critical",
    });
    for (let i = 0; i < 50; i++) await consumeQuota("resend.emails", { priority: "normal" });
    for (let i = 0; i < 16; i++) await consumeQuota("resend.emails", { priority: "high" });
    await expect(consumeQuota("resend.emails", { priority: "normal" })).rejects.toMatchObject({
      resetsAt: nextResetAt(),
    });
    expect(await quotaStatus("resend.emails")).toEqual({
      critical: { used: 30, limit: 30 },
      high: { used: 16, limit: 16 },
      normal: { used: 50, limit: 50 },
      low: { used: 0, limit: 4 },
    });
  });

  test("an amount takes that many and never more than the class has left", async () => {
    await consumeQuota("resend.emails", { priority: "low", amount: 3 });
    await expect(
      consumeQuota("resend.emails", { priority: "low", amount: 2 }),
    ).rejects.toBeInstanceOf(QuotaExceededError);
    await consumeQuota("resend.emails", { priority: "low" });
    expect((await quotaStatus("resend.emails")).low).toEqual({ used: 4, limit: 4 });
  });

  test("the next day starts with the whole allocation again", async () => {
    for (let i = 0; i < 4; i++) await consumeQuota("resend.emails", { priority: "low" });
    await expect(consumeQuota("resend.emails", { priority: "low" })).rejects.toBeInstanceOf(
      QuotaExceededError,
    );
    vi.setSystemTime(nextResetAt());
    await consumeQuota("resend.emails", { priority: "low" });
    expect((await quotaStatus("resend.emails")).low).toEqual({ used: 1, limit: 4 });
  });

  test("unknown quota is invalid", async () =>
    expect(consumeQuota("x", { priority: "low" })).rejects.toBeInstanceOf(InvalidInputError));
});
