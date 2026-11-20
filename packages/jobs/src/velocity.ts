import { withSystem } from "@reranker/db";
import { AppError, cost, type ProviderCost, ProviderCostSchema } from "@reranker/schema";
import { sql } from "drizzle-orm";
import { InvalidInputError } from "./errors";
import { assertOpaqueKey } from "./keys";

const INVALID_PARAMETER = "22023";
// Spend admitted is estimated in USD micros like every spend cap.
const CURRENCY = "USD";

export interface VelocityWindows {
  count10m: number;
  flagged10m: number;
  spend10m: ProviderCost;
  spend60m: ProviderCost;
}

export interface VelocityBaseline {
  p95Count10m: number;
  p95Spend10m: ProviderCost;
  p95Spend60m: ProviderCost;
}

// A parameter the database rejects is invalid input, never an outage.
async function system<T>(fn: Parameters<typeof withSystem<T>>[1]): Promise<T> {
  try {
    return await withSystem("jobs.velocity", fn);
  } catch (error) {
    const cause =
      error instanceof AppError ? (error.cause as { code?: string } | undefined) : undefined;
    if (cause?.code === INVALID_PARAMETER) {
      throw new InvalidInputError("Velocity parameters rejected");
    }
    throw error;
  }
}

/**
 * Adds one request to the key's current minute and returns the ten-minute and one-hour sums in the
 * same round trip. Spend is the estimated cost admitted, not what the provider later charges.
 */
export async function recordVelocity(
  key: string,
  sample: { flagged: boolean; spend: ProviderCost },
): Promise<VelocityWindows> {
  assertOpaqueKey(key);
  const { spend } = sample;
  if (!ProviderCostSchema.safeParse(spend).success || spend.currency !== CURRENCY) {
    throw new InvalidInputError(`Velocity spend must be whole ${CURRENCY} micro-units`);
  }
  const { rows } = await system((tx) =>
    tx.execute<{ count10m: number; flagged10m: number; spend10m: string; spend60m: string }>(
      sql`select * from ops.record_velocity(${key}::text, ${sample.flagged}::boolean, ${spend.amount_micros}::bigint)`,
    ),
  );
  const row = rows[0];
  if (!row) throw new Error("record_velocity returned no row");
  return {
    count10m: row.count10m,
    flagged10m: row.flagged10m,
    spend10m: cost(Number(row.spend10m), CURRENCY),
    spend60m: cost(Number(row.spend60m), CURRENCY),
  };
}

type VelocityRow = { count10m: number; flagged10m: number; spend10m: string; spend60m: string };

/**
 * `recordVelocity` for several keys in one statement, so a caller that feeds more than one window
 * per event takes one connection for all of them. Windows come back in the order of the samples.
 */
export async function recordVelocities(
  samples: ReadonlyArray<{ key: string; flagged: boolean; spend: ProviderCost }>,
): Promise<VelocityWindows[]> {
  for (const { key, spend } of samples) {
    assertOpaqueKey(key);
    if (!ProviderCostSchema.safeParse(spend).success || spend.currency !== CURRENCY) {
      throw new InvalidInputError(`Velocity spend must be whole ${CURRENCY} micro-units`);
    }
  }
  if (samples.length === 0) return [];
  const calls = samples.map(
    (s, i) =>
      sql`select ${i}::int as n, * from ops.record_velocity(${s.key}::text, ${s.flagged}::boolean, ${s.spend.amount_micros}::bigint)`,
  );
  const { rows } = await system((tx) =>
    tx.execute<VelocityRow & { n: number }>(sql`${sql.join(calls, sql` union all `)} order by n`),
  );
  if (rows.length !== samples.length) throw new Error("record_velocity returned no row");
  return rows.map((row) => ({
    count10m: row.count10m,
    flagged10m: row.flagged10m,
    spend10m: cost(Number(row.spend10m), CURRENCY),
    spend60m: cost(Number(row.spend60m), CURRENCY),
  }));
}

/** The key's p95 over the last 7 days as of the latest refresh; null for a key never seen. */
export async function velocityBaseline(key: string): Promise<VelocityBaseline | null> {
  assertOpaqueKey(key);
  const { rows } = await system((tx) =>
    tx.execute<{ count10m: number; spend10m: string; spend60m: string }>(
      sql`select p95_count_10m as count10m,
                 p95_spend_10m_amount_micros as spend10m,
                 p95_spend_60m_amount_micros as spend60m
            from ops.velocity_baselines where key = ${key}`,
    ),
  );
  const row = rows[0];
  if (!row) return null;
  return {
    p95Count10m: row.count10m,
    p95Spend10m: cost(Number(row.spend10m), CURRENCY),
    p95Spend60m: cost(Number(row.spend60m), CURRENCY),
  };
}

// A statement's cost grows with the buckets it reads, and a busy key holds a bucket for each of the
// week's 10,081 minutes, so batches are cut by buckets, not keys. Each key also counts KEY_COST,
// its own fixed overhead, which bounds a batch of keys seen only once too.
const BASELINE_BATCH_COST = 20_000;
const KEY_COST = 5;

/**
 * Recomputes every key's baseline from the last 7 days of buckets: the p95 of the rolling 10 and
 * 60 minute sums over each minute, quiet ones included, from the key's first bucket on. Returns
 * how many keys were computed; a key with no bucket in the week keeps its last baseline.
 *
 * The rolling sums only change where a bucket enters a window or leaves it, so each bucket yields
 * three deltas (now, 10 and 60 minutes later) and a running sum over them gives every constant
 * stretch of the series, weighted by the minutes it lasts. Zero stretches are only counted: when
 * the p95 rank falls among them the answer is 0, otherwise it is found by ranking the positive
 * stretches after the zeros. That is the p95 of the per-minute series without expanding it.
 *
 * Keys go through in key order, in batches of about BASELINE_BATCH_COST, each in its own
 * statement. A batch walks the primary key index from its cursor one key at a time, so it reads
 * only its own keys' buckets however large the table is, and stops at the first key past the
 * budget, which starts the next batch. A key over the budget on its own is a batch by itself.
 */
export async function refreshVelocityBaselines(): Promise<number> {
  let computed = 0;
  let after: string | null = null;
  for (;;) {
    const batch: { computed: number; last: string | null; more: boolean } =
      await refreshBatch(after);
    computed += batch.computed;
    if (!batch.more || !batch.last) return computed;
    after = batch.last;
  }
}

async function refreshBatch(
  cursor: string | null,
): Promise<{ computed: number; last: string | null; more: boolean }> {
  const { rows } = await system((tx) =>
    tx.execute<{ computed: number; last: string | null; more: boolean }>(
      sql`with recursive bounds as (
              select now_minute, now_minute - interval '7 days' as since
                from (select date_trunc('minute', clock_timestamp()) as now_minute) b
            ),
            walk as (
              select k.key, s.first_bucket, s.cost as spent, 1 as n
                from (select v.key from ops.velocity_buckets v
                       where ${cursor}::text is null or v.key > ${cursor}::text
                       order by v.key limit 1) k
               cross join lateral (
                 select min(v.bucket_start) as first_bucket, count(*)::int + ${KEY_COST} as cost
                   from ops.velocity_buckets v, bounds b
                  where v.key = k.key and v.bucket_start >= b.since and v.bucket_start <= b.now_minute
               ) s
              union all
              select k.key, s.first_bucket, w.spent + s.cost, w.n + 1
                from walk w
               cross join lateral (
                 select v.key from ops.velocity_buckets v where v.key > w.key order by v.key limit 1
               ) k
               cross join lateral (
                 select min(v.bucket_start) as first_bucket, count(*)::int + ${KEY_COST} as cost
                   from ops.velocity_buckets v, bounds b
                  where v.key = k.key and v.bucket_start >= b.since and v.bucket_start <= b.now_minute
               ) s
               where w.spent <= ${BASELINE_BATCH_COST}
            ),
            batch as (
              select key, first_bucket from walk where n = 1 or spent <= ${BASELINE_BATCH_COST}
            ),
            keys as (
              select w.key, (date_part('epoch', b.now_minute - w.first_bucket) / 60)::int + 1 as total
                from batch w, bounds b
               where w.first_bucket is not null
            ),
            p95 as (
              select k.key, q.*
                from keys k
               cross join lateral (
                 with deltas as (
                   select e.at, e.count, e.spend10, e.spend60
                     from ops.velocity_buckets v
                    cross join bounds b
                    cross join lateral (select (date_part('epoch', v.bucket_start - b.since) / 60)::int as minute) o
                    cross join lateral (values
                      (o.minute, v.count, v.spend_amount_micros, v.spend_amount_micros),
                      (o.minute + 10, -v.count, -v.spend_amount_micros, 0::bigint),
                      (o.minute + 60, 0, 0::bigint, -v.spend_amount_micros)
                    ) as e (at, count, spend10, spend60)
                    where v.key = k.key and v.bucket_start >= b.since and v.bucket_start <= b.now_minute
                      and e.at <= 10080
                 ),
                 rolling as (
                   select sum(count) over w as count10m,
                          sum(spend10) over w as spend10m,
                          sum(spend60) over w as spend60m,
                          lead(at, 1, 10081) over w - at as minutes
                     from deltas
                   window w as (order by at)
                 ),
                 zeros as (
                   select coalesce(sum(minutes) filter (where count10m = 0), 0) as count10m,
                          coalesce(sum(minutes) filter (where spend10m = 0), 0) as spend10m,
                          coalesce(sum(minutes) filter (where spend60m = 0), 0) as spend60m
                     from rolling
                 ),
                 target as (select ceil(0.95::float8 * k.total::float8) as rank)
                 select
                   coalesce((select case when t.rank <= z.count10m then 0
                                         else min(p.v) filter (where p.cum >= t.rank - z.count10m) end
                               from target t, zeros z,
                                    (select count10m as v, sum(minutes) over (order by count10m) as cum
                                       from rolling where count10m > 0) p
                              group by t.rank, z.count10m), 0) as count10m,
                   coalesce((select case when t.rank <= z.spend10m then 0
                                         else min(p.v) filter (where p.cum >= t.rank - z.spend10m) end
                               from target t, zeros z,
                                    (select spend10m as v, sum(minutes) over (order by spend10m) as cum
                                       from rolling where spend10m > 0) p
                              group by t.rank, z.spend10m), 0) as spend10m,
                   coalesce((select case when t.rank <= z.spend60m then 0
                                         else min(p.v) filter (where p.cum >= t.rank - z.spend60m) end
                               from target t, zeros z,
                                    (select spend60m as v, sum(minutes) over (order by spend60m) as cum
                                       from rolling where spend60m > 0) p
                              group by t.rank, z.spend60m), 0) as spend60m
               ) q
            ),
            upserted as (
              insert into ops.velocity_baselines as b
                     (key, computed_on, p95_count_10m, p95_spend_10m_amount_micros, p95_spend_10m_currency,
                      p95_spend_60m_amount_micros, p95_spend_60m_currency)
              select key, current_date, count10m, spend10m, 'USD', spend60m, 'USD' from p95
              on conflict (key) do update
                 set computed_on = excluded.computed_on,
                     p95_count_10m = excluded.p95_count_10m,
                     p95_spend_10m_amount_micros = excluded.p95_spend_10m_amount_micros,
                     p95_spend_60m_amount_micros = excluded.p95_spend_60m_amount_micros
              returning 1
            )
            select (select count(*) from upserted)::int as computed,
                   (select max(key) from batch) as last,
                   exists (select 1 from walk where spent > ${BASELINE_BATCH_COST}) as more`,
    ),
  );
  const row = rows[0];
  return { computed: row?.computed ?? 0, last: row?.last ?? null, more: row?.more ?? false };
}
