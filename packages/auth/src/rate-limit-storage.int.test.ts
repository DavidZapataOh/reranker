import { randomUUID } from "node:crypto";
import { endPools, withSystem } from "@reranker/db";
import { rateLimits } from "@reranker/db/schema/auth";
import { eq, like, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { rateLimitStorage } from "./rate-limit-storage";

const PREFIX = `test-rl-${randomUUID()}`;
const key = (name: string) => `${PREFIX}|${name}|${randomUUID()}`;
const rule = { window: 600, max: 3 };

// Concurrency is real only with more connections than the default three of the system pool.
beforeAll(() => {
  process.env.DB_POOL_MAX = "20";
});

afterAll(async () => {
  await withSystem("test.cleanup", (tx) =>
    tx.delete(rateLimits).where(like(rateLimits.key, `${PREFIX}|%`)),
  );
  await endPools();
});

const row = (k: string) =>
  withSystem("test.read-rate-limit", async (tx) => {
    const [found] = await tx.select().from(rateLimits).where(eq(rateLimits.key, k));
    return found;
  });

describe("rateLimitStorage.consume", () => {
  test("allows max requests in the window and refuses the next with the wait", async () => {
    const k = key("window");
    for (let i = 0; i < 3; i++) {
      expect(await rateLimitStorage.consume(k, rule)).toEqual({ allowed: true, retryAfter: null });
    }
    const refused = await rateLimitStorage.consume(k, rule);
    expect(refused.allowed).toBe(false);
    expect(refused.retryAfter).toBeGreaterThan(590);
    expect(refused.retryAfter).toBeLessThanOrEqual(600);
    // A refusal writes nothing.
    expect((await row(k))?.count).toBe(3);
  });

  test("an elapsed window starts again at 1", async () => {
    const k = key("elapsed");
    for (let i = 0; i < 3; i++) await rateLimitStorage.consume(k, rule);
    await withSystem("test.age-rate-limit", (tx) =>
      tx
        .update(rateLimits)
        .set({ lastRequest: sql`${rateLimits.lastRequest} - ${rule.window * 1000}` })
        .where(eq(rateLimits.key, k)),
    );
    expect((await rateLimitStorage.consume(k, rule)).allowed).toBe(true);
    expect((await row(k))?.count).toBe(1);
  });

  test("50 concurrent requests on one key allow exactly max", async () => {
    const k = key("race");
    const results = await Promise.all(
      Array.from({ length: 50 }, () => rateLimitStorage.consume(k, rule)),
    );
    expect(results.filter((r) => r.allowed)).toHaveLength(3);
    expect(results.filter((r) => !r.allowed).every((r) => (r.retryAfter ?? 0) > 0)).toBe(true);
  });

  test("keys are independent", async () => {
    const a = key("a");
    for (let i = 0; i < 3; i++) await rateLimitStorage.consume(a, rule);
    expect((await rateLimitStorage.consume(a, rule)).allowed).toBe(false);
    expect((await rateLimitStorage.consume(key("b"), rule)).allowed).toBe(true);
  });
});
