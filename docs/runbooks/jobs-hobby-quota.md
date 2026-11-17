# Workflow events quota

## Trigger

The `jobs-hobby-quota` alert (warning, source `jobs`), raised by the `checkWorkflowQuota` step of the daily maintenance run (05:00 Bogota) when the month's estimated Vercel Workflows events pass 70% of 50,000. The payload carries `month` (Bogota calendar month), `estimated_events`, `limit` and `percent`.

Vercel publishes no usage endpoint for workflow events, so the figure is an estimate: the runs started that month in `ops.workflow_starts`, times the most events a run of each kind writes (`daily` 45, `free-report` 85, `job` 9; a kind without its own figure counts as 85). Runs started without a claim there, such as the deploy ping, are not counted.

50,000 events a month is the Hobby allowance and, on Pro, the budget the free report was sized for: https://vercel.com/docs/workflows/pricing (read 2026-11-16) lists 50,000 events included on Hobby and US$0.02 per 1,000 events on demand, with Pro billed on demand.

## Impact

On Pro nothing stops: every event past the budget is billed, about US$0.02 per free report. On Hobby, past the allowance new runs would stop (Vercel pauses Hobby features at their limits), so free reports, jobs and this maintenance run would not start until the month resets.

## Diagnose

1. The real figure: Vercel dashboard, the team's Usage tab, Workflows, Workflow Events for the current billing period. If it is far below the estimate, runs are writing fewer events than budgeted; the alert is early, not wrong.
2. Which kind grows, from the Neon console SQL editor of `reranker-prod` (Bogota month):

   ```sql
   select kind, count(*) as runs
   from ops.workflow_starts
   where status = 'started'
     and created_at >= date_trunc('month', now() at time zone 'America/Bogota') at time zone 'America/Bogota'
   group by kind order by runs desc;
   ```

   - `free-report` near the figure the funnel expects: real demand, the budget is what has to change.
   - `job` far above the reports that would enqueue them: a retry or re-enqueue loop. Look at Observability, Workflows, filtered by failed runs, and at `jobs.daily.step_failed` in PostHog Logs.
   - A kind that should not exist or should be rare: the code that starts it is looping.

## Mitigate

1. Loop or storm: stop the source first. Turn off the feature flag of the domain workflow that loops (PostHog, Feature flags), then fix the code that re-enqueues; the claims in `ops.workflow_starts` keep a restarted run from duplicating work.
2. Real demand on Pro: nothing to stop. Confirm a budget watches the extra: Vercel, Settings, Billing, Spend Management, Add Budget, scope Product, Workflows, with notifications only (pausing would take production down with it). Raise its amount when the volume is the intended one. Source: https://vercel.com/docs/spend-management (read 2026-11-16).
3. Real demand on Hobby: move the team to Pro the same day (Vercel, Settings, Billing, Upgrade); no code changes, the same deployment keeps running.

## Verify

The next daily run logs `jobs.daily.workflow_quota` with the new estimate, and the Usage tab's Workflow Events grows no faster than the runs the product meant to start.

## Record

In the alert thread or the pull request that fixes it: the month, the estimate and the Usage tab figure, the kind that drove it and the action taken.
