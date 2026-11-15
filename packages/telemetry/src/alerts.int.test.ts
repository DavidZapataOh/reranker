import { endPools, withSystem } from "@reranker/db";
import { alertDeliveries } from "@reranker/db/schema";
import { and, gte, lt, sql } from "drizzle-orm";
import { afterAll, beforeEach, expect, test } from "vitest";
import { claimDelivery } from "./delivery";

// A random day far in the future: the daily cap counts rows, and nothing else writes there.
const year = 2100 + Math.floor(Math.random() * 800);
const month = String(1 + Math.floor(Math.random() * 12)).padStart(2, "0");
const day = String(1 + Math.floor(Math.random() * 27)).padStart(2, "0");
const DAY = `${year}-${month}-${day}`;
const RANGE_START = new Date(`${DAY}T00:00:00-05:00`);
const RANGE_END = new Date(RANGE_START.getTime() + 3 * 24 * 3600 * 1000);

// Bogota is UTC-5 all year.
const at = (clock: string, date = DAY) => new Date(`${date}T${clock}:00-05:00`);

async function cleanup(): Promise<void> {
  await withSystem("test.alerts", (tx) =>
    tx
      .delete(alertDeliveries)
      .where(
        and(
          gte(alertDeliveries.bucketHour, RANGE_START),
          lt(alertDeliveries.bucketHour, RANGE_END),
        ),
      ),
  );
}

async function countBetween(from: Date, to: Date): Promise<number> {
  const { rows } = await withSystem("test.alerts", (tx) =>
    tx.execute<{ n: number }>(
      sql`select count(*)::int as n from ops.alert_deliveries where bucket_hour >= ${from.toISOString()}::timestamptz and bucket_hour < ${to.toISOString()}::timestamptz`,
    ),
  );
  return rows[0]?.n ?? 0;
}

beforeEach(cleanup);
afterAll(async () => {
  await cleanup();
  await endPools();
});

test("20 parallel claims in the same hour insert one row", async () => {
  const results = await Promise.all(
    Array.from({ length: 20 }, () => claimDelivery("jobs-spend-cap-reached", at("10:15"))),
  );
  expect(results.filter(Boolean)).toHaveLength(1);
});

test("a claim in a later hour of the same kind is granted again", async () => {
  expect(await claimDelivery("uptime-down", at("10:15"))).toBe(true);
  expect(await claimDelivery("uptime-down", at("10:59"))).toBe(false);
  expect(await claimDelivery("uptime-down", at("11:00"))).toBe(true);
});

test("the daily cap of 15 holds across kinds", async () => {
  const results: boolean[] = [];
  for (let h = 0; h < 20; h++) {
    results.push(await claimDelivery(`k${h}`, at(`${String(h).padStart(2, "0")}:00`)));
  }
  expect(results.filter(Boolean)).toHaveLength(15);
  expect(results.slice(15).every((granted) => !granted)).toBe(true);
  expect(await countBetween(at("00:00"), at("23:59"))).toBe(15);
});

test("the cap holds under parallel claims of different kinds", async () => {
  const results = await Promise.all(
    Array.from({ length: 25 }, (_, i) => claimDelivery(`p${i}`, at("12:30"))),
  );
  expect(results.filter(Boolean)).toHaveLength(15);
});

test("the cap resets at Bogota midnight", async () => {
  for (let h = 0; h < 15; h++) await claimDelivery(`k${h}`, at(`${String(h).padStart(2, "0")}:00`));
  expect(await claimDelivery("late", at("23:59"))).toBe(false);
  const next = new Date(at("00:00").getTime() + 24 * 3600 * 1000);
  expect(await claimDelivery("early", new Date(next.getTime() + 60_000))).toBe(true);
});
