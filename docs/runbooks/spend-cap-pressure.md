# Free report cap pressure

## Trigger

The `spend-cap-pressure` alert (warning, source `jobs`), raised by the `checkScaleTriggers` step of the daily maintenance run when the free report used 70% or more of its daily cap (`purpose:free-report` in `ops.spend_counters`) on each of the last three closed Bogota days. The payload carries `scope`, `days` and `percents`.

This is the trigger of the "free report cap by demand" stage: the cap was sized for the demand of the day it was set, and three days in a row near it mean real demand is about to be turned away.

## Impact

Nothing is refused yet. If demand keeps growing, the free report reaches 100% of its cap and the next requests wait for the next day (deferred delivery by email), which is a worse first experience for real people.

## Diagnose

From the Neon console SQL editor of `reranker-prod`:

```sql
select day, scope, used_amount_micros / 1e6 as used_usd, cap_amount_micros / 1e6 as cap_usd
from ops.spend_counters
where scope in ('purpose:free-report', 'pool:free-report-anonymous', 'pool:free-report-verified')
  and day > (now() at time zone 'America/Bogota')::date - 7
order by day, scope;
```

- Spend spread over many reports at the usual cost each, from many networks: real demand.
- One pool near its cap and the other idle: the split is wrong, not the total.
- Spend from a few networks, or guard modes active (`select * from ops.guard_modes where released_at is null;`): abuse, handled by [Spend cap reached](jobs-spend-cap-reached.md) instead.

## Mitigate

1. Real demand: raise `SPEND_CAP_DAILY_FREE_REPORT_USD` in Vercel, Settings, Environment Variables, Production, together with `SPEND_CAP_DAILY_FREE_REPORT_ANONYMOUS_USD` and `SPEND_CAP_DAILY_FREE_REPORT_VERIFIED_USD` so the two pools still add up to it, and `SPEND_CAP_DAILY_GLOBAL_USD` if the new total needs it. Size it to the last week's peak plus 30%.
2. Raise the provider backstops to match (DataForSEO account cost limit, OpenAI project budget), so the provider cuts only after ours.
3. Redeploy production (Deployments, the current production deployment, Redeploy): caps are read once per process.

## Verify

The next three daily runs show the free report under 70% of its new cap and no `spend-cap-pressure` alert.

## Record

In the alert thread or the pull request: the three days and their percentages, the cause, the caps before and after, and the cost per report used to size them.
