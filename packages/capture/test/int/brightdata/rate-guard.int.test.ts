import { endPools, withSystem } from "@reranker/db";
import { guardModeStatus } from "@reranker/jobs";
import { sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, test } from "vitest";
import { assertNotRateLimited, RATE_GUARD, record429 } from "../../../src/brightdata/rate-guard";

afterAll(() => endPools());

// The guard is fleet-wide by design, so each test starts from a clean slate.
beforeEach(async () => {
  await withSystem("test.brightdata.rate-guard", async (tx) => {
    await tx.execute(sql`delete from ops.rate_buckets where key = ${RATE_GUARD.bucket}`);
    await tx.execute(sql`delete from ops.guard_modes where name = ${RATE_GUARD.mode}`);
  });
});

describe("Bright Data 429 guard", () => {
  test("nine 429s keep calls flowing", async () => {
    for (let i = 0; i < 9; i++) await record429();
    await expect(assertNotRateLimited()).resolves.toBeUndefined();
  });

  test("the 10th 429 in 5 minutes trips the fleet guard; the next call is refused", async () => {
    for (let i = 0; i < 10; i++) await record429();
    const refused = await assertNotRateLimited().catch((error: unknown) => error);
    expect(refused).toMatchObject({ name: "RateLimited" });
    const { retryAfterMs } = refused as { retryAfterMs: number };
    expect(retryAfterMs).toBeGreaterThan(290_000);
    expect(retryAfterMs).toBeLessThanOrEqual(300_000);
    expect(await guardModeStatus(RATE_GUARD.mode)).toMatchObject({ active: true });
  });

  test("an always-429 provider gets no more than 10 429s from a sequential caller", async () => {
    let sent = 0;
    for (let i = 0; i < 40; i++) {
      const allowed = await assertNotRateLimited().then(
        () => true,
        () => false,
      );
      if (!allowed) continue;
      sent += 1;
      await record429();
    }
    expect(sent).toBe(10);
  });

  test("concurrent callers overshoot by at most the calls already in flight, well under 25", async () => {
    const workers = 8;
    let sent = 0;
    await Promise.all(
      Array.from({ length: workers }, async () => {
        for (let i = 0; i < 20; i++) {
          const allowed = await assertNotRateLimited().then(
            () => true,
            () => false,
          );
          if (!allowed) return;
          sent += 1;
          await record429();
        }
      }),
    );
    expect(sent).toBeGreaterThanOrEqual(10);
    expect(sent).toBeLessThanOrEqual(10 + workers - 1);
  });
});
