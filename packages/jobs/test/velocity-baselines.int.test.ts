import { randomUUID } from "node:crypto";
import { endPools, type SystemTx, withSystem } from "@reranker/db";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { refreshVelocityBaselines, velocityBaseline } from "../src/velocity";

beforeAll(() => {
  process.env.DB_POOL_MAX = "20";
});
afterAll(() => endPools());

const WEEK_MINUTES = 7 * 24 * 60;

interface Bucket {
  minutesAgo: number;
  count: number;
  spend: number;
}

// Deterministic generator so a failing case replays.
function prng(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Shape = "sparse" | "bursty" | "dense" | "edges";

function randomBuckets(rand: () => number, shape: Shape): Bucket[] {
  const minutes = new Set<number>();
  const pick = (n: number) => Math.floor(rand() * n);
  if (shape === "sparse") {
    for (let i = 0, n = 1 + pick(60); i < n; i++) minutes.add(pick(WEEK_MINUTES + 1));
  } else if (shape === "bursty") {
    for (let burst = 0, bursts = 1 + pick(8); burst < bursts; burst++) {
      const start = pick(WEEK_MINUTES + 1);
      for (let i = 0, n = 1 + pick(90); i < n; i++) minutes.add(Math.max(0, start - i));
    }
  } else if (shape === "dense") {
    for (let m = pick(2000); m <= WEEK_MINUTES; m++) if (rand() < 0.8) minutes.add(m);
  } else {
    // Window edges: 9/10/59/60 minutes apart, the week boundary and the current minute.
    const anchors = [0, 1, WEEK_MINUTES, WEEK_MINUTES - 1, 5000 + pick(100)];
    for (const a of anchors) {
      for (const d of [0, 9, 10, 11, 59, 60, 61]) minutes.add(Math.max(0, a - d));
    }
  }
  return [...minutes].map((minutesAgo) => ({
    minutesAgo,
    count: pick(4) === 0 ? 0 : 1 + pick(40),
    spend: pick(3) === 0 ? 0 : pick(5_000_000_000),
  }));
}

// One bound parameter per array: drizzle would otherwise expand a JS array into a row of parameters.
const pgArray = (values: (string | number)[]) =>
  `{${values.map((v) => `"${String(v).replace(/(["\\])/g, "\\$1")}"`).join(",")}}`;

// Seeding, cleanup and the oracle write and read whole weeks of buckets on a database other suites
// load at the same time. They are not what is under test, so they get the longest statement timeout
// a transaction may ask for; the refresh keeps the default one.
const fixture = <T>(fn: (tx: SystemTx) => Promise<T>) =>
  withSystem("test.velocity-baselines", fn, { statementTimeoutMs: 60_000 });

// Inserted in one statement; duplicate minutes collapse on the primary key like real traffic.
async function insertBuckets(rows: { key: string; b: Bucket }[]) {
  await fixture((tx) =>
    tx.execute(
      sql`insert into ops.velocity_buckets (key, bucket_start, count, flagged, spend_amount_micros, spend_currency)
          select k, date_trunc('minute', clock_timestamp()) - m * interval '1 minute', c, 0, s, 'USD'
            from unnest(${pgArray(rows.map((r) => r.key))}::text[], ${pgArray(rows.map((r) => r.b.minutesAgo))}::int[],
                        ${pgArray(rows.map((r) => r.b.count))}::int[], ${pgArray(rows.map((r) => r.b.spend))}::bigint[])
                 as t (k, m, c, s)
          on conflict do nothing`,
    ),
  );
}

async function clear(keys: string[]) {
  await fixture(async (tx) => {
    await tx.execute(
      sql`delete from ops.velocity_buckets where key = any(${pgArray(keys)}::text[])`,
    );
    await tx.execute(
      sql`delete from ops.velocity_baselines where key = any(${pgArray(keys)}::text[])`,
    );
  });
}

const currentMinute = () =>
  fixture(async (tx) => {
    const { rows } = await tx.execute<{ m: string }>(
      sql`select extract(epoch from date_trunc('minute', clock_timestamp()))::text as m`,
    );
    return rows[0]?.m;
  });

type Reference = {
  key: string;
  p95_count_10m: number;
  p95_spend_10m: string;
  p95_spend_60m: string;
};

// The original algorithm, kept as the oracle: one row per minute from the key's first bucket, with
// 10 and 60 row windows over them.
async function oracle(keys: string[]): Promise<Map<string, Reference>> {
  const { rows } = await fixture((tx) =>
    tx.execute<Reference>(
      sql`with bounds as (
            select now_minute, now_minute - interval '7 days' as since
              from (select date_trunc('minute', clock_timestamp()) as now_minute) b
          ),
          firsts as (
            select v.key, min(v.bucket_start) as first_bucket
              from ops.velocity_buckets v, bounds b
             where v.bucket_start >= b.since and v.key = any(${pgArray(keys)}::text[])
             group by v.key
          ),
          minutes as (
            select f.key, m.minute
              from firsts f, bounds b,
                   generate_series(f.first_bucket, b.now_minute, interval '1 minute') as m (minute)
          ),
          per_minute as (
            select m.key, m.minute,
                   coalesce(v.count, 0) as count,
                   coalesce(v.spend_amount_micros, 0)::bigint as spend
              from minutes m
              left join ops.velocity_buckets v on v.key = m.key and v.bucket_start = m.minute
          ),
          rolling as (
            select key,
                   sum(count) over w10 as count10m,
                   sum(spend) over w10 as spend10m,
                   sum(spend) over w60 as spend60m
              from per_minute
            window w10 as (partition by key order by minute rows between 9 preceding and current row),
                   w60 as (partition by key order by minute rows between 59 preceding and current row)
          )
          select key,
                 percentile_disc(0.95) within group (order by count10m)::int as p95_count_10m,
                 percentile_disc(0.95) within group (order by spend10m)::text as p95_spend_10m,
                 percentile_disc(0.95) within group (order by spend60m)::text as p95_spend_60m
            from rolling
           group by key`,
    ),
  );
  return new Map(rows.map((r) => [r.key, r]));
}

async function expectBaselines(keys: string[], expected: Map<string, Reference>) {
  expect(expected.size).toBe(keys.length);
  for (const k of keys) {
    const want = expected.get(k);
    expect(await velocityBaseline(k), k).toEqual({
      p95Count10m: want?.p95_count_10m,
      p95Spend10m: { amount_micros: Number(want?.p95_spend_10m), currency: "USD" },
      p95Spend60m: { amount_micros: Number(want?.p95_spend_60m), currency: "USD" },
    });
  }
}

describe("refreshVelocityBaselines", () => {
  test("matches the per-minute reference on randomized buckets", async () => {
    const shapes: Shape[] = ["sparse", "bursty", "dense", "edges"];
    const rand = prng(20261117);
    for (let round = 0; round < 3; round++) {
      const keys: string[] = [];
      const rows: { key: string; b: Bucket }[] = [];
      for (const shape of shapes) {
        for (let i = 0; i < 4; i++) {
          const k = `test:velocity-baselines:${shape}:${randomUUID()}`;
          keys.push(k);
          for (const b of randomBuckets(rand, shape)) rows.push({ key: k, b });
        }
      }
      try {
        await insertBuckets(rows);
        // The oracle and the refresh each read the clock; a minute rollover between them is retried.
        for (let attempt = 0; ; attempt++) {
          const before = await currentMinute();
          const expected = await oracle(keys);
          await refreshVelocityBaselines();
          if ((await currentMinute()) === before) {
            await expectBaselines(keys, expected);
            break;
          }
          expect(attempt).toBeLessThan(3);
        }
      } finally {
        await clear(keys);
      }
    }
  }, 120_000);

  test("refreshes busy and sparse keys of a week, each batch inside the statement timeout", async () => {
    const rand = prng(7);
    const traffic = () => ({
      count: 1 + Math.floor(rand() * 20),
      spend: Math.floor(rand() * 2_000_000),
    });
    const sparse = Array.from(
      { length: 300 },
      () => `test:velocity-baselines:sparse:${randomUUID()}`,
    );
    // A bucket in every minute of the week: the most one key can hold.
    const busy = Array.from({ length: 4 }, () => `test:velocity-baselines:busy:${randomUUID()}`);
    const keys = [...sparse, ...busy];
    const rows: { key: string; b: Bucket }[] = [];
    for (const key of sparse) {
      for (let i = 0; i < 400; i++) {
        rows.push({
          key,
          b: { minutesAgo: Math.floor(rand() * (WEEK_MINUTES + 1)), ...traffic() },
        });
      }
    }
    for (const key of busy) {
      for (let m = 0; m <= WEEK_MINUTES; m++)
        rows.push({ key, b: { minutesAgo: m, ...traffic() } });
    }
    try {
      await insertBuckets(rows);
      // Keys from every batch. Each batch is one statement under the default 5 s timeout, so a
      // batch that outgrew it fails the refresh here.
      const checked = [...busy, ...[...sparse].sort().filter((_, i) => i % 40 === 0)];
      for (let attempt = 0; ; attempt++) {
        const before = await currentMinute();
        const started = performance.now();
        const computed = await refreshVelocityBaselines();
        console.info(
          `velocity refresh: ${computed} keys in ${Math.round(performance.now() - started)} ms`,
        );
        expect(computed).toBeGreaterThanOrEqual(keys.length);
        const expected = await oracle(checked);
        if ((await currentMinute()) === before) {
          await expectBaselines(checked, expected);
          break;
        }
        expect(attempt).toBeLessThan(3);
      }
    } finally {
      await clear(keys);
    }
  }, 120_000);
});
