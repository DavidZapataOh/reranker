# Provider call volume

## Trigger

The `provider-volume` alert (warning, source `jobs`), raised by the `checkScaleTriggers` step of the daily maintenance run when the month's paid provider calls pass 2 million. Every paid provider call reserves its spend first, so the count is the month's rows in `ops.spend_ledger` that were not released, without the latency probe's. The payload carries `month`, `calls` and `threshold`.

This is the trigger of the Temporal stage: Vercel Workflows is the equivalent durable engine at today's volume, and Temporal (workers with heartbeats, per-provider queues, priority and fairness) pays off past this volume or once workers run outside Node.

## Impact

Nothing fails. Past this volume the per-step batching, the lease waits and the workflow event spend grow together, and priority between paid and free work gets harder to keep inside `acquire_slot`.

## Diagnose

From the Neon console SQL editor of `reranker-prod`:

```sql
select provider, purpose, count(*) as calls
from ops.spend_ledger
where day >= date_trunc('month', now() at time zone 'America/Bogota')::date
  and status <> 'released' and ref_type <> 'latency-probe'
group by 1, 2 order by calls desc;
```

- Growth spread over providers and purposes in line with reports sold or served: real volume.
- One purpose or `ref_type` far above the others: a loop; handle it as in [Spend cap reached](jobs-spend-cap-reached.md).

## Mitigate

1. A loop: stop its source with its feature flag, then fix it.
2. Real volume: plan the move to Temporal Cloud (activity = batch with heartbeat, a queue per provider, paid work first), with workers on ECS and Valkey for the primitives. Run both engines behind a flag per workflow kind and move one kind at a time.

## Verify

The daily run logs `jobs.daily.provider_volume` with the month's count; after a loop fix the daily growth returns to the rate of reports served.

## Record

In the alert thread or the pull request: the month, the count by provider and purpose, and the decision taken.
