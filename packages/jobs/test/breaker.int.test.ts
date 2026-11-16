import { randomUUID } from "node:crypto";
import { endPools, withSystem } from "@reranker/db";
import { sql } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { breakerCheck, breakerRecord } from "../src/breaker";

// Concurrency is real only with more connections than the default three of the system pool.
beforeAll(() => {
  process.env.APP_ENV ??= "development";
  process.env.DB_POOL_MAX = "20";
});

// A pool of its own stands in for another instance of the fleet.
const otherInstance = new pg.Pool({ connectionString: process.env.DATABASE_URL_SYSTEM, max: 2 });
afterAll(async () => {
  await otherInstance.end();
  await endPools();
});

const account = () => `test:${randomUUID()}`;

async function checkFromOtherInstance(provider: string, acct: string) {
  const { rows } = await otherInstance.query<{ state: string; retry_after_ms: number }>(
    "select * from ops.breaker_check($1, $2, 30000)",
    [provider, acct],
  );
  return { state: rows[0]?.state, retryAfterMs: rows[0]?.retry_after_ms ?? 0 };
}

const expireOpen = (provider: string, acct: string) =>
  withSystem("test.breaker", (tx) =>
    tx.execute(
      sql`update ops.breaker_state set open_until = clock_timestamp() - interval '1 millisecond'
           where provider = ${provider} and account = ${acct}`,
    ),
  );

async function openBreaker(acct: string) {
  const outcomes = [...Array(12).fill("failure"), ...Array(8).fill("success")] as const;
  await Promise.all(outcomes.map((o) => breakerRecord("dataforseo", o, acct)));
}

describe("breaker", () => {
  test("20 outcomes with 12 failures open it for every process within 1 s", async () => {
    const acct = account();
    await openBreaker(acct);
    const startedAt = Date.now();
    const other = await checkFromOtherInstance("dataforseo", acct);
    expect(Date.now() - startedAt).toBeLessThan(1000);
    expect(other.state).toBe("open");
    expect(other.retryAfterMs).toBeGreaterThan(29_000);
    expect(other.retryAfterMs).toBeLessThanOrEqual(30_000);
    expect((await breakerCheck("dataforseo", acct)).state).toBe("open");
  });

  test("after the open window exactly one caller gets the probe", async () => {
    const acct = account();
    await openBreaker(acct);
    await expireOpen("dataforseo", acct);
    const states = await Promise.all(
      Array.from({ length: 10 }, () => breakerCheck("dataforseo", acct)),
    );
    expect(states.filter((s) => s.state === "half_open")).toHaveLength(1);
    const waiting = states.filter((s) => s.state === "open");
    expect(waiting).toHaveLength(9);
    for (const s of waiting) expect(s.retryAfterMs).toBeGreaterThan(0);
  });

  test("a probe success closes it and forgets the window", async () => {
    const acct = account();
    await openBreaker(acct);
    await expireOpen("dataforseo", acct);
    expect((await breakerCheck("dataforseo", acct)).state).toBe("half_open");
    await breakerRecord("dataforseo", "success", acct);
    expect(await breakerCheck("dataforseo", acct)).toEqual({ state: "closed", retryAfterMs: 0 });
    // The old failures are gone: one more failure cannot reopen it.
    await breakerRecord("dataforseo", "failure", acct);
    expect((await breakerCheck("dataforseo", acct)).state).toBe("closed");
  });

  test("a probe failure reopens it for 30 s", async () => {
    const acct = account();
    await openBreaker(acct);
    await expireOpen("dataforseo", acct);
    expect((await breakerCheck("dataforseo", acct)).state).toBe("half_open");
    await breakerRecord("dataforseo", "failure", acct);
    const after = await breakerCheck("dataforseo", acct);
    expect(after.state).toBe("open");
    expect(after.retryAfterMs).toBeGreaterThan(29_000);
    expect(after.retryAfterMs).toBeLessThanOrEqual(30_000);
  });

  test("19 calls never open it, whatever the failures", async () => {
    const acct = account();
    await Promise.all(
      Array.from({ length: 19 }, () => breakerRecord("dataforseo", "failure", acct)),
    );
    expect((await breakerCheck("dataforseo", acct)).state).toBe("closed");
  });

  test("a healthy ratio stays closed even with many calls", async () => {
    const acct = account();
    const outcomes = [...Array(30).fill("success"), ...Array(10).fill("failure")] as const;
    await Promise.all(outcomes.map((o) => breakerRecord("dataforseo", o, acct)));
    expect((await breakerCheck("dataforseo", acct)).state).toBe("closed");
  });

  test("an account is its own breaker, and the default account is named 'default'", async () => {
    const acct = account();
    await openBreaker(acct);
    expect((await breakerCheck("dataforseo", account())).state).toBe("closed");
    try {
      await breakerRecord("xai", "success");
      const { rows } = await withSystem("test.breaker", (tx) =>
        tx.execute(
          sql`select 1 from ops.breaker_windows where provider = 'xai' and account = 'default'`,
        ),
      );
      expect(rows).toHaveLength(1);
    } finally {
      await withSystem("test.breaker", (tx) =>
        tx.execute(
          sql`delete from ops.breaker_windows where provider = 'xai' and account = 'default'`,
        ),
      );
    }
  });
});
