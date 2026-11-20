import { randomUUID } from "node:crypto";
import { endPools, withSystem } from "@reranker/db";
import { cost } from "@reranker/schema";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { InvalidInputError } from "../src/errors";
import {
  recordVelocities,
  recordVelocity,
  refreshVelocityBaselines,
  velocityBaseline,
} from "../src/velocity";

beforeAll(() => {
  process.env.DB_POOL_MAX = "20";
});
afterAll(() => endPools());

const key = (name: string) => `test:velocity:${name}:${randomUUID()}`;

// The tests write relative to the database clock, the one record_velocity buckets by.
async function currentMinute(): Promise<string> {
  const { rows } = await withSystem("test.velocity", (tx) =>
    tx.execute<{ m: string }>(sql`select date_trunc('minute', clock_timestamp())::text as m`),
  );
  const m = rows[0]?.m;
  if (!m) throw new Error("The database returned no clock");
  return m;
}

// Buckets are placed from one reading of the clock, so a minute that rolls over between seeds
// cannot shift one onto another; seeds that must keep their spacing share an anchor.
async function seedBuckets(
  k: string,
  buckets: { minutesAgo: number; count: number; spend?: number }[],
  anchor?: string,
) {
  const at = anchor ?? (await currentMinute());
  await withSystem("test.velocity", (tx) =>
    tx.execute(
      sql`insert into ops.velocity_buckets (key, bucket_start, count, flagged, spend_amount_micros, spend_currency)
          values ${sql.join(
            buckets.map(
              (b) =>
                sql`(${k}, ${at}::timestamptz - ${b.minutesAgo} * interval '1 minute', ${b.count}, 0, ${b.spend ?? 0}, 'USD')`,
            ),
            sql`, `,
          )}`,
    ),
  );
}

// One bucket per minute for a week; the last `spikeMinutes` minutes before the end carry `spikeCount`.
async function seedWeek(
  k: string,
  w: { perMinute: number; spikeMinutes: number; spikeCount: number; spikeSpend: number },
) {
  await withSystem("test.velocity", (tx) =>
    tx.execute(
      sql`insert into ops.velocity_buckets (key, bucket_start, count, flagged, spend_amount_micros, spend_currency)
          select ${k}, m, case when m >= date_trunc('minute', clock_timestamp()) - ${w.spikeMinutes} * interval '1 minute' - interval '1 day'
                                and m < date_trunc('minute', clock_timestamp()) - interval '1 day'
                               then ${w.spikeCount}::int else ${w.perMinute}::int end,
                 0, case when m >= date_trunc('minute', clock_timestamp()) - ${w.spikeMinutes} * interval '1 minute' - interval '1 day'
                          and m < date_trunc('minute', clock_timestamp()) - interval '1 day'
                         then ${w.spikeSpend}::bigint else 0::bigint end, 'USD'
            from generate_series(date_trunc('minute', clock_timestamp()) - interval '6 days 23 hours',
                                 date_trunc('minute', clock_timestamp()), interval '1 minute') m`,
    ),
  );
}

describe("recordVelocity", () => {
  test("12 records over 3 minutes give count10m = 12", async () => {
    const k = key("window");
    await seedBuckets(k, [
      { minutesAgo: 2, count: 4 },
      { minutesAgo: 1, count: 4 },
    ]);
    let last: Awaited<ReturnType<typeof recordVelocity>> | undefined;
    for (let i = 0; i < 4; i++) {
      last = await recordVelocity(k, { flagged: i === 0, spend: cost(900_000, "USD") });
    }
    expect(last).toMatchObject({ count10m: 12, flagged10m: 1 });
    expect(last?.spend10m.amount_micros).toBe(3_600_000);
    expect(last?.spend60m.amount_micros).toBe(3_600_000);
  });

  test("after 11 minutes without writes only the new one counts", async () => {
    const k = key("stale");
    await seedBuckets(k, [{ minutesAgo: 11, count: 12, spend: 5_000_000 }]);
    const r = await recordVelocity(k, { flagged: false, spend: cost(0, "USD") });
    expect(r.count10m).toBe(1);
    expect(r.spend10m.amount_micros).toBe(0);
    // The old minute is outside ten minutes but inside the hour.
    expect(r.spend60m.amount_micros).toBe(5_000_000);
  });

  test("spend60m sums the hour and leaves out what is older", async () => {
    const k = key("hour");
    await seedBuckets(k, [
      { minutesAgo: 30, count: 1, spend: 2_000_000 },
      { minutesAgo: 57, count: 1, spend: 3_000_000 },
      { minutesAgo: 75, count: 1, spend: 9_000_000 },
    ]);
    const r = await recordVelocity(k, { flagged: false, spend: cost(1_000_000, "USD") });
    expect(r.spend60m.amount_micros).toBe(6_000_000);
    expect(r.spend10m.amount_micros).toBe(1_000_000);
  });

  test("concurrent records of one key lose no count", async () => {
    const k = key("race");
    const queue = Array.from(
      { length: 40 },
      () => () => recordVelocity(k, { flagged: false, spend: cost(10, "USD") }),
    );
    await Promise.all(
      Array.from({ length: 20 }, async () => {
        for (let next = queue.shift(); next; next = queue.shift()) await next();
      }),
    );
    const r = await recordVelocity(k, { flagged: false, spend: cost(10, "USD") });
    expect(r.count10m).toBe(41);
    expect(r.spend10m.amount_micros).toBe(410);
  });

  test("records several keys in one statement, each into its own window", async () => {
    const a = key("many-a");
    const b = key("many-b");
    await recordVelocity(a, { flagged: true, spend: cost(0, "USD") });
    const [wa, wb] = await recordVelocities([
      { key: a, flagged: false, spend: cost(5, "USD") },
      { key: b, flagged: true, spend: cost(0, "USD") },
    ]);
    expect(wa).toMatchObject({ count10m: 2, flagged10m: 1, spend10m: cost(5, "USD") });
    expect(wb).toMatchObject({ count10m: 1, flagged10m: 1, spend10m: cost(0, "USD") });
  });

  test("a batch of one key counts each sample in order, as separate records would", async () => {
    const k = key("batch");
    const windows = await recordVelocities(
      Array.from({ length: 300 }, (_, i) => ({
        key: k,
        flagged: i % 3 === 0,
        spend: cost(0, "USD"),
      })),
    );
    expect(windows.map((w) => w.count10m)).toEqual(Array.from({ length: 300 }, (_, i) => i + 1));
    expect(windows.at(-1)?.flagged10m).toBe(100);
  });

  test("rejects raw addresses, emails, negative or non-USD spend", async () => {
    const ok = { flagged: false, spend: cost(0, "USD") };
    await expect(recordVelocity("203.0.113.9", ok)).rejects.toBeInstanceOf(InvalidInputError);
    await expect(recordVelocity("ana@example.com", ok)).rejects.toBeInstanceOf(InvalidInputError);
    await expect(
      recordVelocity(key("neg"), { flagged: false, spend: { amount_micros: -1, currency: "USD" } }),
    ).rejects.toBeInstanceOf(InvalidInputError);
    await expect(
      recordVelocity(key("cur"), { flagged: false, spend: cost(1, "COP") }),
    ).rejects.toBeInstanceOf(InvalidInputError);
  });
});

describe("velocityBaseline", () => {
  test("is the p95 of 7 days of rolling windows", async () => {
    const k = key("week");
    await seedWeek(k, { perMinute: 1, spikeMinutes: 20, spikeCount: 30, spikeSpend: 1_000_000 });
    expect(await refreshVelocityBaselines()).toBeGreaterThanOrEqual(1);
    expect(await velocityBaseline(k)).toMatchObject({
      p95Count10m: 10,
      p95Spend10m: { amount_micros: 0, currency: "USD" },
      p95Spend60m: { amount_micros: 0, currency: "USD" },
    });
  });

  test("a key never seen has no baseline, and a refresh replaces the old one", async () => {
    expect(await velocityBaseline(key("never"))).toBeNull();
    const k = key("again");
    const now = await currentMinute();
    await seedBuckets(k, [{ minutesAgo: 1, count: 3 }], now);
    await refreshVelocityBaselines();
    const first = await velocityBaseline(k);
    await seedBuckets(k, [{ minutesAgo: 2, count: 50 }], now);
    await refreshVelocityBaselines();
    const second = await velocityBaseline(k);
    expect(first?.p95Count10m).toBe(3);
    expect(second?.p95Count10m).toBe(53);
  });
});
