import { randomUUID } from "node:crypto";
import { endPools, withSystem } from "@reranker/db";
import { cost } from "@reranker/schema";
import { type SQL, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import {
  checkWorkflowQuota,
  cleanupLeases,
  reconcileSpend,
  registerSpendSource,
} from "../src/maintenance";

// Reconciliation reads the spend currency from the job config, which needs to know the environment.
vi.stubEnv("APP_ENV", "development");

afterAll(() => endPools());

const system = async <R extends Record<string, unknown>>(query: SQL): Promise<R[]> =>
  (await withSystem("test.maintenance", (tx) => tx.execute(query))).rows as R[];

const usd = (micros: number) => cost(micros, "USD");

// Each run works on its own far-away day and month, so rows of other tests (or of an earlier run
// on the same database) never meet these.
const year = 3000 + Math.floor(Math.random() * 5000);
const day = `${year}-03-14`;
const month = `${year}-03`;

describe("cleanupLeases", () => {
  const key = (name: string) => `test:maintenance:${name}:${randomUUID()}`;
  const keys = {
    expiredLease: key("lease-expired"),
    liveLease: key("lease-live"),
    idleBucket: key("bucket-idle"),
    usedBucket: key("bucket-used"),
    velocity: key("velocity"),
    breaker: `test-maintenance-${randomUUID()}`,
  };

  beforeAll(async () => {
    await system(sql`insert into ops.concurrency_leases (key, expires_at) values
      (${keys.expiredLease}, clock_timestamp() - interval '1 second'),
      (${keys.liveLease}, clock_timestamp() + interval '2 minutes')`);
    await system(sql`insert into ops.rate_buckets (key, tokens, updated_at) values
      (${keys.idleBucket}, 1, clock_timestamp() - interval '2 days 1 minute'),
      (${keys.usedBucket}, 1, clock_timestamp() - interval '1 day 23 hours')`);
    await system(sql`insert into ops.velocity_buckets (key, bucket_start, count, flagged, spend_amount_micros, spend_currency)
      select ${keys.velocity}, date_trunc('minute', clock_timestamp()) - d * interval '1 day', 1, 0, 0, 'USD'
        from unnest(array[9, 8.01, 7.99, 1]) d`);
    await system(sql`insert into ops.breaker_windows (provider, account, bucket_start, calls, failures)
      select ${keys.breaker}, 'default',
             date_bin('10 seconds', clock_timestamp(), timestamptz '1970-01-01 00:00:00+00') - s * interval '1 second', 1, 0
        from unnest(array[130, 70, 40, 0]) s`);
  });

  const leases = () =>
    system<{ key: string }>(
      sql`select key from ops.concurrency_leases where key in (${keys.expiredLease}, ${keys.liveLease})`,
    );
  const buckets = () =>
    system<{ key: string }>(
      sql`select key from ops.rate_buckets where key in (${keys.idleBucket}, ${keys.usedBucket})`,
    );
  const velocityDays = async () =>
    (
      await system<{
        days: number;
      }>(sql`select round(extract(epoch from date_trunc('minute', clock_timestamp()) - bucket_start) / 86400, 2)::float8 as days
        from ops.velocity_buckets where key = ${keys.velocity} order by bucket_start`)
    ).map((row) => row.days);
  // Ages sit 10 s away from the 60 s edge, so a bucket boundary passing mid-test changes nothing.
  const windows = async () =>
    (
      await system<{ n: number }>(
        sql`select count(*)::int as n from ops.breaker_windows where provider = ${keys.breaker}`,
      )
    )[0]?.n;

  test("removes expired leases, buckets idle 2 days, velocity past 8 days and breaker windows past the minute", async () => {
    const removed = await cleanupLeases();
    expect(removed.leases).toBeGreaterThanOrEqual(1);
    expect(removed.buckets).toBeGreaterThanOrEqual(1);
    expect(removed.velocity).toBeGreaterThanOrEqual(2);
    expect(removed.breakerWindows).toBeGreaterThanOrEqual(2);

    expect((await leases()).map((row) => row.key)).toEqual([keys.liveLease]);
    expect((await buckets()).map((row) => row.key)).toEqual([keys.usedBucket]);
    expect(await velocityDays()).toEqual([7.99, 1]);
    // The breaker reads the last 60 seconds of buckets, so only those stay.
    expect(await windows()).toBe(2);
  });

  test("a second pass right after finds nothing of its own to remove", async () => {
    await cleanupLeases();
    expect((await leases()).map((row) => row.key)).toEqual([keys.liveLease]);
    expect((await buckets()).map((row) => row.key)).toEqual([keys.usedBucket]);
  });
});

describe("reconcileSpend", () => {
  const reported = new Map<string, number>();
  registerSpendSource("dataforseo", { usage: async () => usd(reported.get("dataforseo") ?? 0) });
  registerSpendSource("brightdata", { usage: async () => usd(reported.get("brightdata") ?? 0) });

  async function ledgerRow(row: {
    provider: string;
    status: "reserved" | "settled";
    reserved: number;
    actual?: number;
    minutesAgo: number;
  }): Promise<string> {
    const [inserted] = await system<{ id: string }>(sql`insert into ops.spend_ledger
      (day, provider, purpose, scopes, ref_type, ref_id, reserved_amount_micros, reserved_currency,
       actual_amount_micros, actual_currency, status, created_at)
      values (${day}::date, ${row.provider}, 'benchmark', array['global', ${`provider:${row.provider}`}],
              'test', ${randomUUID()}, ${row.reserved}, 'USD', ${row.actual ?? 0}, 'USD', ${row.status},
              clock_timestamp() - make_interval(mins => ${row.minutesAgo}))
      returning id`);
    if (!inserted) throw new Error("no ledger row");
    return inserted.id;
  }
  const statusOf = async (id: string) =>
    (
      await system<{ status: string }>(
        sql`select status from ops.spend_ledger where id = ${id}::uuid`,
      )
    )[0]?.status;
  const usedOf = async (scope: string) =>
    Number(
      (
        await system<{ used: string }>(sql`select used_amount_micros as used from ops.spend_counters
          where day = ${day}::date and scope = ${scope}`)
      )[0]?.used ?? 0,
    );

  test("releases reservations older than 15 minutes and reports gaps over 5% and US$0.50", async () => {
    const stale = await ledgerRow({
      provider: "dataforseo",
      status: "reserved",
      reserved: 300_000,
      minutesAgo: 16,
    });
    const fresh = await ledgerRow({
      provider: "dataforseo",
      status: "reserved",
      reserved: 200_000,
      minutesAgo: 5,
    });
    await ledgerRow({
      provider: "dataforseo",
      status: "settled",
      reserved: 12_000_000,
      actual: 10_000_000,
      minutesAgo: 60,
    });
    await ledgerRow({
      provider: "brightdata",
      status: "settled",
      reserved: 2_000_000,
      actual: 1_000_000,
      minutesAgo: 60,
    });
    await system(sql`insert into ops.spend_counters (day, scope, cap_amount_micros, cap_currency, used_amount_micros, used_currency)
      values (${day}::date, 'global', 75000000, 'USD', 11500000, 'USD'),
             (${day}::date, 'provider:dataforseo', 36000000, 'USD', 10500000, 'USD'),
             (${day}::date, 'provider:brightdata', 5000000, 'USD', 1000000, 'USD')`);
    // DataForSEO is 0.4 apart on 10 (4%); Bright Data 0.6 apart on 1.
    reported.set("dataforseo", 10_400_000);
    reported.set("brightdata", 1_600_000);

    await expect(reconcileSpend(day)).resolves.toEqual({
      released: 1,
      mismatches: [
        { provider: "brightdata", ledger: usd(1_000_000), provider_reported: usd(1_600_000) },
      ],
    });
    expect(await statusOf(stale)).toBe("released");
    expect(await statusOf(fresh)).toBe("reserved");
    expect(await usedOf("global")).toBe(11_200_000);
    expect(await usedOf("provider:dataforseo")).toBe(10_200_000);

    // Run again, as a duplicated cron delivery would: nothing more is released.
    await expect(reconcileSpend(day)).resolves.toMatchObject({ released: 0 });
    expect(await usedOf("global")).toBe(11_200_000);
  });
});

describe("checkWorkflowQuota", () => {
  // Bogota midnight is 05:00Z, so the first and last instants of the local month sit around it.
  async function started(kind: string, runs: number, at: string) {
    await system(sql`insert into ops.workflow_starts (kind, key, run_id, status, created_at)
      select ${kind}, ${`${month}:${randomUUID()}`} || ':' || i, 'wrun_test', 'started', ${at}::timestamptz
        from generate_series(1, ${runs}) i`);
  }

  afterAll(() => system(sql`delete from ops.workflow_starts where key like ${`${month}:%`}`));

  test("counts the started runs of the local month and alerts above 70% of 50,000 events", async () => {
    await started("free-report", 407, `${year}-03-01T05:00:00Z`);
    await started("job", 45, `${year}-04-01T04:59:59Z`);
    // Outside the month in Bogota, and a claim that never started.
    await started("free-report", 50, `${year}-03-01T04:59:59Z`);
    await started("free-report", 50, `${year}-04-01T05:00:00Z`);
    await system(sql`insert into ops.workflow_starts (kind, key, status, created_at)
      values ('free-report', ${`${month}:${randomUUID()}`}, 'pending', ${`${year}-03-15T12:00:00Z`}::timestamptz)`);

    const onAlert = vi.fn();
    await expect(checkWorkflowQuota(month, { onAlert })).resolves.toEqual({
      estimatedEvents: 35_000,
      ratio: 0.7,
    });
    expect(onAlert).not.toHaveBeenCalled();

    await started("daily", 1, `${year}-03-20T10:00:00Z`);
    await checkWorkflowQuota(month, { onAlert });
    expect(onAlert).toHaveBeenCalledExactlyOnceWith({
      kind: "jobs-hobby-quota",
      payload: { month, estimated_events: 35_045, limit: 50_000, percent: 70 },
    });
  });
});
