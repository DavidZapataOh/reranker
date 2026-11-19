import { toDbError } from "@reranker/db";
import { authDb } from "@reranker/db/auth-adapter";
import type { BetterAuthRateLimitOptions } from "better-auth";
import { sql } from "drizzle-orm";

type ConsumeRow = { allowed: boolean; last_request: string | null; now: string };

/**
 * Better Auth's window counter in one statement on auth.rate_limits: a new key starts at 1, an
 * elapsed window restarts at 1, and a full window is refused without a write. The built-in
 * database storage reads, writes and reads again, up to three checkouts per request, so a burst
 * on a slow link ran the pool past its checkout timeout before any endpoint ran.
 */
export const rateLimitStorage: NonNullable<BetterAuthRateLimitOptions["customStorage"]> = {
  async consume(key, { window, max }) {
    const windowMs = window * 1000;
    let row: ConsumeRow | undefined;
    try {
      const { rows } = await authDb.execute<ConsumeRow>(sql`
        with clock as (select (extract(epoch from clock_timestamp()) * 1000)::bigint as ms),
        hit as (
          insert into auth.rate_limits as r (key, count, last_request)
          select ${key}, 1, clock.ms from clock
          on conflict (key) do update
             set count = case when excluded.last_request - r.last_request >= ${windowMs}
                              then 1 else r.count + 1 end,
                 last_request = excluded.last_request
           where excluded.last_request - r.last_request >= ${windowMs} or r.count < ${max}
          returning 1
        )
        select exists (select from hit) as allowed,
               (select last_request from auth.rate_limits where key = ${key}) as last_request,
               (select ms from clock) as now`);
      row = rows[0];
    } catch (error) {
      // Translated so the key, which holds the client IP, never reaches a log inside the SQL.
      throw toDbError(error, { pool: "system" });
    }
    if (!row) throw new Error("rate limit statement returned no row");
    if (row.allowed) return { allowed: true, retryAfter: null };
    // A refusing row committed after this statement's snapshot is not visible here; the whole
    // window is then the safe wait.
    const waitMs =
      row.last_request === null ? windowMs : Number(row.last_request) + windowMs - Number(row.now);
    return { allowed: false, retryAfter: Math.max(1, Math.ceil(waitMs / 1000)) };
  },
};
