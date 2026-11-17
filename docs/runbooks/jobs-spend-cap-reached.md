# Spend cap reached

## Trigger

The `jobs-spend-cap-reached` alert (source `jobs`), raised by `reserveSpend` when a daily spend scope crosses 80% of its cap (`threshold: 80`, warning) or reaches 100% (`threshold: 100`, critical, emailed). A reservation the cap turns away also raises the 100% alert, without `used_micros` and `cap_micros`. Each scope alerts at most once per threshold per Bogota day across every instance.

The payload carries `scope` (`global`, `provider:<provider>`, `purpose:<purpose>` or `pool:<pool>`), `threshold` and, when a reservation crossed it, `used_micros` and `cap_micros` (USD micro-units: 1,000,000 is US$1).

## Impact

At 80% nothing is refused yet. At 100% every new reservation that charges that scope fails with `SpendCapExceeded` until the counters reset at midnight Bogota: steps fail without retrying, and API callers get `spend_cap_reached` (503 with `retry_after` until the reset). Work that charges other scopes keeps running, unless the scope is `global`, which every reservation charges.

## Diagnose

From the Neon console SQL editor of `reranker-prod`, today's counters and who spent them:

```sql
select scope, used_amount_micros / 1e6 as used_usd, cap_amount_micros / 1e6 as cap_usd
from ops.spend_counters
where day = (now() at time zone 'America/Bogota')::date
order by used_amount_micros::numeric / nullif(cap_amount_micros, 0) desc nulls last;

select provider, purpose, pool, ref_type, status, count(*) as reservations,
       sum(reserved_amount_micros) / 1e6 as reserved_usd, sum(actual_amount_micros) / 1e6 as actual_usd
from ops.spend_ledger
where day = (now() at time zone 'America/Bogota')::date
group by 1, 2, 3, 4, 5
order by reserved_usd desc;
```

- One `ref_type` with far more reservations than the product meant to start: a loop or a retry storm. Look for `jobs.step.retry` and `jobs.step.fatal` in PostHog (Product analytics, Trends, breakdown by `workflow` and `step`).
- Many `reserved` rows older than 15 minutes: functions died before settling. Reserving releases them on its own when a cap looks full, and the daily maintenance run releases the rest.
- Reservations spread over many reports with the usual cost each: real demand.
- Spend coming from a few networks or a burst of anonymous free reports: check the abuse guard modes with `select * from ops.guard_modes where released_at is null;`.

## Mitigate

1. Loop, storm or abuse: stop the source first. Turn off the feature flag of the domain workflow that loops, or close the capture switch of the provider or channel as in [Disable a capture channel](disable-capture-channel.md). Spend stops at once; the counters keep what was charged.
2. Real demand that the budget can take: raise the cap of the scope in Vercel, Settings, Environment Variables, Production, `SPEND_CAP_DAILY_<SCOPE>_USD` in dollars (for example `SPEND_CAP_DAILY_GLOBAL_USD`, `SPEND_CAP_DAILY_DATAFORSEO_USD`, `SPEND_CAP_DAILY_FREE_REPORT_USD`). The free report pools `FREE_REPORT_ANONYMOUS` and `FREE_REPORT_VERIFIED` must still add up to `FREE_REPORT`, and `FREE_REPORT_ELSEWHERE` cannot exceed it; otherwise the jobs configuration refuses to load and every reservation fails. Then redeploy (Deployments, the current production deployment, Redeploy): caps are read once per process.
3. When a provider cap goes up, raise its backstop at the provider too, so the provider cuts only after ours: the DataForSEO account cost limit (daily cap plus 20%) and the OpenAI project budget.
4. Anything else: let the cap hold. The counters reset at midnight Bogota and refused work retries or is delivered later by its own flow.

## Verify

After the redeploy, a new reservation on the scope succeeds and `jobs.spend.reserved` events appear again in PostHog for that provider and purpose; the first query shows the new `cap_usd` for today once a reservation lands. After a stopped loop, `used_usd` stops growing within a few minutes.

## Record

In the alert thread or the pull request that fixes it: the scope, the threshold, what drove the spend and the action taken, with any cap change and its new value. For alerts, the alert-to-action time target is 15 minutes between 07:00 and 22:00 (Bogota).
