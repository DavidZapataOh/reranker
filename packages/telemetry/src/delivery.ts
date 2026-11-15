import { withSystem } from "@reranker/db";
import { sql } from "drizzle-orm";

export const DAILY_EMAIL_CAP = 15;

/**
 * Claims the one email allowed for this kind in this hour, within the daily cap counted from
 * Bogota midnight. The advisory lock serializes concurrent claims so neither the primary key nor
 * the cap count can be raced; the lock releases with the transaction.
 */
export async function claimDelivery(kind: string, now: Date = new Date()): Promise<boolean> {
  const at = now.toISOString();
  const { rows } = await withSystem("ops.alert", async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('ops.alert_deliveries'))`);
    return tx.execute<{ kind: string }>(sql`
      with today as (
        select date_trunc('day', ${at}::timestamptz at time zone 'America/Bogota')
                 at time zone 'America/Bogota' as starts
      )
      insert into ops.alert_deliveries (kind, bucket_hour)
      select ${kind}, date_trunc('hour', ${at}::timestamptz)
      where (
        select count(*) from ops.alert_deliveries, today
        where bucket_hour >= today.starts and bucket_hour < today.starts + interval '1 day'
      ) < ${DAILY_EMAIL_CAP}
      on conflict do nothing
      returning kind`);
  });
  return rows.length === 1;
}
