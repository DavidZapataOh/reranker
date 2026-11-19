import { endPools } from "@reranker/db";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { InvalidInputError, QuotaExceededError } from "../src/errors";
import type { JobPriority } from "../src/providers";
import { consumeQuota, quotaStatus } from "../src/quota";

// Quotas read the job config, which needs to know the environment.
vi.stubEnv("APP_ENV", "development");

const INSTANCES = 4;

// Each import after a reset is a module graph of its own, with its own pool at the default size
// and its own batches: separate function instances contending for the same hour's row.
async function load() {
  vi.resetModules();
  const [quota, errors, db] = await Promise.all([
    import("../src/quota"),
    import("../src/errors"),
    import("@reranker/db"),
  ]);
  return { consumeQuota: quota.consumeQuota, QuotaExceededError: errors.QuotaExceededError, db };
}
const instances: Awaited<ReturnType<typeof load>>[] = [];
beforeAll(async () => {
  // One at a time: a reset while another graph is still importing would mix the two.
  for (let i = 0; i < INSTANCES; i++) instances.push(await load());
});
afterAll(async () => {
  await Promise.all([...instances.map(({ db }) => db.endPools()), endPools()]);
});

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

// Every send is issued at once, spread over the instances. Each one must get a decision: a grant
// or QuotaExceeded, never a pool or lock timeout.
async function burst(count: number, priority: JobPriority): Promise<number> {
  const sends = Array.from({ length: count }, (_, i) => {
    const instance = instances[i % INSTANCES];
    if (!instance) throw new Error("instances are not loaded");
    return instance.consumeQuota("resend.emails", { priority }).then(
      () => true,
      (error: unknown) => {
        expect(error).toBeInstanceOf(instance.QuotaExceededError);
        return false;
      },
    );
  });
  return (await Promise.all(sends)).filter(Boolean).length;
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
