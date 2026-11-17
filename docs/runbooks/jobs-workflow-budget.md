# Vercel Workflows budget

## Trigger

The `jobs-workflow-budget` alert (source `jobs`), raised by the `checkWorkflowBudget` step of the daily maintenance run (05:00 Bogota) when the month's estimated Vercel Workflows spend reaches 70% of the monthly budget (warning) or 100% (critical, emailed). The payload carries `month` (Bogota calendar month), `estimated_events`, `spend_usd`, `budget_usd`, `percent`, `threshold` and `severity`.

The budget is `WORKFLOWS_MONTHLY_BUDGET_USD` (US$10 when unset). Pro bills every workflow event on demand at US$0.02 per 1,000 events, with no allowance that runs out: https://vercel.com/docs/workflows/pricing (read 2026-11-17).

Vercel publishes no usage endpoint for workflow events, so the figure is an estimate: the runs started that month in `ops.workflow_starts`, times the most events a run of each kind writes (`daily` 45, `free-report` 85, `job` 9; a kind without its own figure counts as 85), priced at the Pro rate. Runs started without a claim there, such as the deploy ping, are not counted.

## Impact

Nothing stops: every event past the budget is billed, about US$0.0017 per free report. The alert says the month costs more than planned, or that something loops.

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
2. Real demand: raise `WORKFLOWS_MONTHLY_BUDGET_USD` in Vercel, Settings, Environment Variables, Production, and redeploy (the jobs configuration is read once per process). Keep a Vercel budget watching the same product: Settings, Billing, Spend Management, Add Budget, scope Product, Workflows, with notifications only (pausing would take production down with it). Source: https://vercel.com/docs/spend-management (read 2026-11-16).

## Verify

The next daily run logs `jobs.daily.workflow_budget` with the new estimate under the line, and the Usage tab's Workflow Events grows no faster than the runs the product meant to start.

## Record

In the alert thread or the pull request that fixes it: the month, the estimate and the Usage tab figure, the kind that drove it, the budget before and after, and the action taken.
