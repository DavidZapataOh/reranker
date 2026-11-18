import { endPools } from "@reranker/db";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { InvalidInputError, QuotaExceededError } from "../src/errors";
import type { JobPriority } from "../src/providers";
import { consumeQuota, quotaStatus } from "../src/quota";

// Quotas read the job config, which needs to know the environment.
vi.stubEnv("APP_ENV", "development");

// Concurrency is real only with more connections than the default three of the system pool.
beforeAll(() => {
  process.env.DB_POOL_MAX = "20";
});
afterAll(() => endPools());

const HOUR = 3_600_000;

// Every test runs in a week of its own, so neither its hours nor the peak it reads ever meet
// another test's or another run's sharing the database. Noon in Bogota is 17:00Z.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const year = 2100 + Math.floor(Math.random() * 800);
  const week = Math.floor(Math.random() * 50);
  vi.setSystemTime(new Date(Date.UTC(year, 0, 8 + week * 7, 17, 12)));
});
afterEach(() => {
  vi.useRealTimers();
});

const nextHour = () => new Date(Math.floor(Date.now() / HOUR) * HOUR + HOUR);
const fill = (priority: JobPriority, amount: number) =>
  consumeQuota("resend.emails", { priority, amount });
const send = (priority: JobPriority) => consumeQuota("resend.emails", { priority });

// Waves of 100 keep every call contending on the hour's row while staying inside the pool's
// 2 s connection timeout; the database never sees more than the pool's 20 at once anyway.
async function burst(count: number, priority: JobPriority): Promise<number> {
  let granted = 0;
  for (let done = 0; done < count; done += 100) {
    const wave = await Promise.allSettled(
      Array.from({ length: Math.min(100, count - done) }, () => send(priority)),
    );
    for (const r of wave) {
      if (r.status === "fulfilled") granted++;
      else expect(r.reason).toBeInstanceOf(QuotaExceededError);
    }
  }
  return granted;
}

describe("the hourly email brake", () => {
  test("300 report emails in one hour all pass with the 500 floor", async () => {
    expect(await burst(300, "normal")).toBe(300);
    expect((await quotaStatus("resend.emails")).normal).toEqual({ used: 300, limit: 400 });
  });

  test("past 0.8 H normal stops but critical codes still go out, and the wait is minutes", async () => {
    await fill("normal", 400);
    await expect(send("normal")).rejects.toMatchObject({
      name: "QuotaExceeded",
      quota: "resend.emails",
      priority: "normal",
      resetsAt: nextHour(),
    });
    await send("critical");
    await send("high");
    await expect(send("low")).rejects.toBeInstanceOf(QuotaExceededError);
    expect(await quotaStatus("resend.emails")).toEqual({
      critical: { used: 402, limit: 500 },
      high: { used: 402, limit: 500 },
      normal: { used: 402, limit: 400 },
      low: { used: 402, limit: 50 },
    });
  });

  test("H follows ten times last week's busiest hour, never the current one", async () => {
    const now = Date.now();
    vi.setSystemTime(now - 3 * 24 * HOUR);
    await fill("critical", 120);
    vi.setSystemTime(now - 8 * 24 * HOUR);
    await fill("critical", 200);
    vi.setSystemTime(now);
    await fill("critical", 450);
    expect((await quotaStatus("resend.emails")).critical).toEqual({ used: 450, limit: 1_200 });
  });

  test("nothing is ever deferred to the next day", async () => {
    // 23:59:30 in Bogota is 04:59:30Z of the next UTC day.
    const today = Math.floor(Date.now() / (24 * HOUR)) * 24 * HOUR;
    vi.setSystemTime(today + 24 * HOUR + 5 * HOUR - 30_000);
    await fill("low", 50);
    const error = await send("low").catch((e) => e);
    expect(error).toBeInstanceOf(QuotaExceededError);
    expect(error.resetsAt.getTime() - Date.now()).toBe(30_000);
    vi.setSystemTime(error.resetsAt);
    await send("low");
  });

  test("10× burst: 5,000 concurrent consumes never pass H and count once each", async () => {
    expect(await burst(5_000, "critical")).toBe(500);
    expect((await quotaStatus("resend.emails")).critical).toEqual({ used: 500, limit: 500 });
  }, 120_000);

  test("unknown quota is invalid", async () =>
    expect(consumeQuota("x", { priority: "low" })).rejects.toBeInstanceOf(InvalidInputError));
});
