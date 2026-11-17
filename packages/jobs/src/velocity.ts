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

/**
 * Recomputes every key's baseline from the last 7 days of buckets: the p95 of the rolling 10 and
 * 60 minute sums over each minute, quiet ones included, from the key's first bucket on. Returns
 * how many keys were computed; a key with no bucket in the week keeps its last baseline.
 */
export async function refreshVelocityBaselines(): Promise<number> {
  const { rows } = await system((tx) =>
    tx.execute<{ computed: number }>(
      sql`with bounds as (
            select now_minute, now_minute - interval '7 days' as since
              from (select date_trunc('minute', clock_timestamp()) as now_minute) b
          ),
          firsts as (
            select v.key, min(v.bucket_start) as first_bucket
              from ops.velocity_buckets v, bounds b
             where v.bucket_start >= b.since
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
          ),
          p95 as (
            select key,
                   percentile_disc(0.95) within group (order by count10m) as count10m,
                   percentile_disc(0.95) within group (order by spend10m) as spend10m,
                   percentile_disc(0.95) within group (order by spend60m) as spend60m
              from rolling
             group by key
          ),
          upserted as (
            insert into ops.velocity_baselines as b
                   (key, computed_on, p95_count_10m, p95_spend_10m_amount_micros, p95_spend_10m_currency,
                    p95_spend_60m_amount_micros, p95_spend_60m_currency)
            select key, current_date, count10m, spend10m::bigint, 'USD', spend60m::bigint, 'USD' from p95
            on conflict (key) do update
               set computed_on = excluded.computed_on,
                   p95_count_10m = excluded.p95_count_10m,
                   p95_spend_10m_amount_micros = excluded.p95_spend_10m_amount_micros,
                   p95_spend_60m_amount_micros = excluded.p95_spend_60m_amount_micros
            returning 1
          )
          select count(*)::int as computed from upserted`,
    ),
  );
  return rows[0]?.computed ?? 0;
}
