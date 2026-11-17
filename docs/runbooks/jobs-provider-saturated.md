# Provider saturated

## Trigger

The `jobs-provider-saturated` alert (warning, source `jobs`), raised by `providerCapacity` when the predicted wait for a provider has stayed above 60 seconds for more than 10 minutes. It alerts at most once an hour per provider across every instance. The payload carries `provider`, `predicted_wait_ms` (the latest reading) and `saturated_minutes`.

The predicted wait is the demand beyond the provider's concurrency limit (slots in flight plus calls planned and not started) in rounds of its median call time. Each reading above 60 seconds keeps the guard mode `jobs-saturated:<provider>` on for another 60 seconds; the alert means it has held without a gap for 10 minutes.

## Impact

Nothing fails. Calls to the provider queue for a free slot, so work that needs it finishes later, and admission reads the same wait to warn or defer free reports instead of promising a time it cannot keep. Other providers are unaffected.

## Diagnose

From the Neon console SQL editor of `reranker-prod`:

```sql
select name, tripped_at, active_until, now() - tripped_at as saturated_for
from ops.guard_modes
where name like 'jobs-saturated:%' and released_at is null and active_until > now();

select p.key, p.max_in_flight, count(l.lease_id) as in_flight
from ops.lease_pools p
left join ops.concurrency_leases l on l.key = p.key and l.expires_at > now()
group by p.key, p.max_in_flight;
```

- `in_flight` at `max_in_flight` and the number of reports started this hour in line with the funnel: real demand above the provider's concurrency. For DataForSEO the ceiling is 28 slots of the 30 its account allows, about 2 to 3 reports at once.
- `in_flight` at the limit with far more work than reports: a loop or retry storm holding slots. Look at `jobs.step.retry` and `jobs.lease.denied` in PostHog (Product analytics, Trends, breakdown by `provider`).
- `in_flight` well below the limit while the mode stays on: calls are slow rather than many. Compare the provider's latency with its status page; slow calls raise the median and with it the wait.

## Mitigate

1. Loop or storm: stop the source by turning off the feature flag of the domain workflow that loops; the queued work drains within a few call times.
2. Real demand on DataForSEO: ask DataForSEO support in writing to raise the account's concurrency. Only once they confirm the new limit, set `DATAFORSEO_MAX_IN_FLIGHT` in Vercel, Settings, Environment Variables, Production, two below their figure, and redeploy (Deployments, the current production deployment, Redeploy). Bright Data, OpenAI, Gemini and Google Places have their own `BRIGHTDATA_MAX_IN_FLIGHT`, `OPENAI_MAX_IN_FLIGHT`, `GEMINI_MAX_IN_FLIGHT` and `GOOGLE_PLACES_MAX_IN_FLIGHT`; raise one only within what that provider's plan allows.
3. A slow provider: nothing to change on our side; if its incident drags on and the breaker opens, follow [Provider breaker open](jobs-breaker-open.md).

## Verify

The guard mode of the provider is released (the first query returns no row for it) within a minute or two of the wait dropping below 60 seconds, and no new `jobs-provider-saturated` alert follows in the next hour.

## Record

In the alert thread or the pull request that fixes it: the provider, how long it stayed saturated, the cause and the action taken, with any concurrency request, its date and the answer. For alerts, the alert-to-action time target is 15 minutes between 07:00 and 22:00 (Bogota).
