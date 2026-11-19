import { randomUUID } from "node:crypto";
import { endPools, withSystem } from "@reranker/db";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { InvalidInputError } from "../src/errors";
import {
  type BucketLimits,
  peekTokens,
  refundAllTokens,
  refundTokens,
  takeAllTokens,
  takeTokens,
} from "../src/rate";

// Concurrency is real only with more connections than the default three of the system pool.
beforeAll(() => {
  process.env.DB_POOL_MAX = "20";
});
afterAll(() => endPools());

const perHour: BucketLimits = { capacity: 3, refillPerSecond: 3 / 3600 };
const key = (name: string) => `test:rate:${name}:${randomUUID()}`;

describe("takeTokens", () => {
  test("3 per hour grants 3 and denies the fourth with the exact wait", async () => {
    const k = key("hour");
    for (let i = 0; i < 3; i++) expect((await takeTokens(k, perHour)).ok).toBe(true);
    const denied = await takeTokens(k, perHour);
    expect(denied.ok).toBe(false);
    expect(denied.retryAfterMs).toBeGreaterThan(1_190_000);
    expect(denied.retryAfterMs).toBeLessThanOrEqual(1_200_000);
  });

  test("reports what is left after a grant", async () => {
    const granted = await takeTokens(key("left"), perHour, 2);
    expect(granted.ok).toBe(true);
    expect(granted.remaining).toBeCloseTo(1, 2);
    expect(granted.retryAfterMs).toBe(0);
  });

  test("50 concurrent takes never over-grant", async () => {
    const k = key("race");
    // 50 calls race through 20 workers, one per pooled connection: the row lock serializes them,
    // and more callers than connections would only wait out the pool's 2 s checkout timeout.
    const queue = Array.from({ length: 50 }, () => () => takeTokens(k, perHour));
    const results: Awaited<ReturnType<typeof takeTokens>>[] = [];
    await Promise.all(
      Array.from({ length: 20 }, async () => {
        for (let next = queue.shift(); next; next = queue.shift()) results.push(await next());
      }),
    );
    expect(results).toHaveLength(50);
    expect(results.filter((r) => r.ok)).toHaveLength(3);
  });

  test("a cost above the capacity is invalid input, not a database error", async () => {
    await expect(takeTokens(key("cost"), perHour, 4)).rejects.toBeInstanceOf(InvalidInputError);
  });

  test("a cleaned-up bucket starts full again", async () => {
    const k = key("vanish");
    await takeTokens(k, perHour);
    await withSystem("test.rate", (tx) =>
      tx.execute(sql`delete from ops.rate_buckets where key = ${k}`),
    );
    expect((await takeTokens(k, perHour)).ok).toBe(true);
  });

  test("rejects a raw address before touching the database", async () => {
    await expect(takeTokens("free:ip:181.49.10.2", perHour)).rejects.toBeInstanceOf(
      InvalidInputError,
    );
    await expect(peekTokens("otp:a@b.co", perHour)).rejects.toBeInstanceOf(InvalidInputError);
    await expect(refundTokens("free:ip:::ffff:1.2.3.4", perHour)).rejects.toBeInstanceOf(
      InvalidInputError,
    );
  });

  test.each([
    { capacity: 0, refillPerSecond: 1 },
    { capacity: 1, refillPerSecond: 0 },
    { capacity: Number.NaN, refillPerSecond: 1 },
  ])("rejects limits %j", async (limits) => {
    await expect(takeTokens(key("limits"), limits)).rejects.toBeInstanceOf(InvalidInputError);
  });
});

describe("takeAllTokens and refundAllTokens", () => {
  const perDay: BucketLimits = { capacity: 5, refillPerSecond: 5 / 86_400 };

  test("takes from every bucket or from none, with the wait of the short one", async () => {
    const hour = key("all-hour");
    const day = key("all-day");
    const both = [
      { key: hour, limits: perHour },
      { key: day, limits: perDay },
    ];
    for (let i = 0; i < 3; i++) expect((await takeAllTokens(both)).ok).toBe(true);
    const denied = await takeAllTokens(both);
    expect(denied.ok).toBe(false);
    expect(denied.retryAfterMs).toBeGreaterThan(1_190_000);
    expect(denied.retryAfterMs).toBeLessThanOrEqual(1_200_000);
    // The denial took nothing from the bucket that still had tokens.
    expect((await peekTokens(day, perDay)).remaining).toBeCloseTo(2, 2);
  });

  test("50 concurrent sends over shared buckets never over-grant", async () => {
    const shared = key("all-shared");
    const queue = Array.from(
      { length: 50 },
      (_, i) => () =>
        takeAllTokens([
          { key: key(`all-own-${i}`), limits: perHour },
          { key: shared, limits: perHour },
        ]),
    );
    const results: Awaited<ReturnType<typeof takeAllTokens>>[] = [];
    await Promise.all(
      Array.from({ length: 20 }, async () => {
        for (let next = queue.shift(); next; next = queue.shift()) results.push(await next());
      }),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(3);
  });

  test("a refund gives every bucket its token back", async () => {
    const hour = { key: key("all-refund-hour"), limits: perHour };
    const day = { key: key("all-refund-day"), limits: perDay };
    await takeAllTokens([hour, day]);
    await refundAllTokens([hour, day]);
    expect((await peekTokens(hour.key, perHour)).remaining).toBeCloseTo(3, 2);
    expect((await peekTokens(day.key, perDay)).remaining).toBeCloseTo(5, 2);
  });

  test("concurrent refunds over the same buckets in opposite orders all land", async () => {
    const a = { key: key("all-order-a"), limits: perDay };
    const b = { key: key("all-order-b"), limits: perDay };
    await takeAllTokens([
      { ...a, cost: 5 },
      { ...b, cost: 5 },
    ]);
    await Promise.all(
      Array.from({ length: 10 }, (_, i) => refundAllTokens(i % 2 ? [a, b] : [b, a])),
    );
    expect((await peekTokens(a.key, perDay)).remaining).toBeCloseTo(5, 2);
    expect((await peekTokens(b.key, perDay)).remaining).toBeCloseTo(5, 2);
  });
});

describe("peekTokens and refundTokens", () => {
  test("peek does not consume and shows a full bucket for an unknown key", async () => {
    const k = key("peek");
    const fresh = await peekTokens(k, perHour);
    expect(fresh.remaining).toBe(3);
    expect(fresh.retryAfterMs).toBe(0);
    await takeTokens(k, perHour);
    const before = await peekTokens(k, perHour);
    expect((await peekTokens(k, perHour)).remaining).toBeCloseTo(before.remaining, 3);
    expect(before.remaining).toBeCloseTo(2, 2);
  });

  test("peek reports the wait until one token is back", async () => {
    const k = key("wait");
    await takeTokens(k, perHour, 3);
    const peeked = await peekTokens(k, perHour);
    expect(peeked.retryAfterMs).toBeGreaterThan(1_190_000);
    expect(peeked.retryAfterMs).toBeLessThanOrEqual(1_200_000);
  });

  test("a refund gives one back and the next take passes", async () => {
    const k = key("refund");
    for (let i = 0; i < 3; i++) await takeTokens(k, perHour);
    expect((await takeTokens(k, perHour)).ok).toBe(false);
    await refundTokens(k, perHour);
    expect((await takeTokens(k, perHour)).ok).toBe(true);
  });

  test("a refund never exceeds the capacity", async () => {
    const k = key("cap");
    await refundTokens(k, perHour, 10);
    expect((await peekTokens(k, perHour)).remaining).toBeLessThanOrEqual(3);
  });

  test("a negative refund is invalid input", async () => {
    await expect(refundTokens(key("neg"), perHour, -1)).rejects.toBeInstanceOf(InvalidInputError);
  });
});
