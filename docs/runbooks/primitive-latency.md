# Capacity primitive latency

## Trigger

The `primitive-latency` alert (warning, source `jobs`), raised by the `checkScaleTriggers` step of the daily maintenance run once the p95 of admitting a provider call (breaker check, lease and rate bucket, all Postgres functions in `ops`) has been above 25 ms on every daily reading for a week. Each run times 50 admissions from the function region with `probeSpendPath` on its own lease pool (`latency-probe`), reserving one micro-dollar of the contract-test cap and settling it at zero, so nothing is spent. A reading above budget keeps the guard mode `trigger:primitive-latency` on for 36 hours; a day within budget lets it lapse and restarts the count. The payload carries `p95_ms`, `budget_ms` and `since`.

This is the trigger of the Valkey stage: at today's volume the primitives measure 8–16 ms in Postgres, and Valkey is only worth its cost once they no longer fit the budget.

## Impact

Every provider call waits longer before it starts, which adds to the free report's p95 (budget under 120 s) and to every paid job. Nothing fails.

## Diagnose

1. The readings: PostHog Logs, `jobs.daily.primitive_latency`, the last 14 days. A sudden jump points at a change; a slow climb points at load.
2. Neon: the console's Monitoring tab for `reranker-prod`, CPU and connections at the time of the daily run. Compute pinned at its maximum CU means the database, not the primitives, is the limit (raise the maximum first).
3. Lock contention on the hot rows:

   ```sql
   select relname, n_tup_upd, n_dead_tup from pg_stat_user_tables
   where schemaname = 'ops' order by n_tup_upd desc limit 10;
   ```

   Many dead tuples on `rate_buckets`, `concurrency_leases` or `breaker_windows`: the cleanup step is not keeping up.

## Mitigate

1. A regression from a recent deployment: roll it back (Vercel, Deployments, the previous production deployment, Promote) and fix it.
2. Compute saturated: raise the maximum CU of `reranker-prod` (Neon, Branches, main, Computes, Edit).
3. Sustained load with the database healthy: move buckets, leases and the breaker to Valkey behind a flag, with the Postgres path kept as fallback. Valkey needs a network path from Vercel; plan it together with Temporal.

## Verify

The daily reading drops to 25 ms or less and the guard mode `trigger:primitive-latency` lapses (`select * from ops.guard_modes where name = 'trigger:primitive-latency';`).

## Record

In the alert thread or the pull request: the week's readings, the cause, the action and the readings after it.
