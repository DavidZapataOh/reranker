# Workflow steps failing

## Trigger

The `jobs-workflow-failures` alert (critical, source `jobs`), raised by `reportStepError` when a fourth step fails fatally within 15 minutes across every instance. It alerts at most once an hour. The payload carries `workflow`, `step` and `error` of the step that tipped it over, and `window_minutes`.

A step fails fatally when its error says retrying cannot help: a spend cap reached (`SpendCapExceeded`), a provider refusing the request (`ProviderRejected`), invalid input or a missing record (`InvalidInput`, `NotFound`), a job out of attempts (`JobAttemptsExhausted`), a closed capture switch (`CaptureChannelDisabled`) or a non-retryable catalog error (its code). Every one is also a `jobs.step.fatal` event; retried failures are `jobs.step.retry` and never count.

## Impact

Each fatal step ends its run without retrying: the report, job or maintenance task it belonged to is not completed by that run. Runs whose steps succeed keep going.

## Diagnose

1. Which steps and errors: PostHog, Product analytics, new Trends insight on `jobs.step.fatal` for the last hour, breakdown by `error`, then by `workflow` and `step`.
2. The runs themselves: Vercel, the project, Observability, Workflows, filtered by failed runs; a failed step shows the error type and message.
3. Read the error type:
   - `SpendCapExceeded`: a daily cap is full; follow [Spend cap reached](jobs-spend-cap-reached.md).
   - `ProviderRejected`: the provider refuses what we send. The same code across many runs means our request or credentials changed (a deployment or a rotated key), not the customers' data.
   - `InvalidInput`, `NotFound` or a catalog code right after a deployment: a bug in that release.
   - `JobAttemptsExhausted`: a job failed on every attempt; its message in the run names the last cause.
   - `CaptureChannelDisabled`: expected while a capture switch is closed on purpose.
   - Many steps of `daily`: see `jobs.daily.step_failed` in PostHog Logs for the step and error.

## Mitigate

1. A bug in the current release: roll back (Vercel, Deployments, the previous production deployment, Instant Rollback), or turn off the feature flag of the domain workflow if the rest of the release must stay.
2. A provider refusing requests: restore or rotate the credential in Vercel, Settings, Environment Variables, and redeploy; if it is the provider's change, close its capture switch as in [Disable a capture channel](disable-capture-channel.md) until the adapter is fixed.
3. A full spend cap or a closed switch: the failures are the intended outcome; act on the cap or the switch, not on the steps.
4. Failed runs are not retried on their own. Once the cause is gone, the daily maintenance runs again at 05:00 Bogota, or the same day as in [Network ranges stale](network-ranges-stale.md) (Mitigate, step 4); other work starts again from the flow that owns it.

## Verify

`jobs.step.fatal` stops growing in the PostHog trend within 15 minutes of the fix, and new runs of the same workflow complete in Observability.

## Record

In the alert thread or the pull request that fixes it: the workflow, step and error, how many runs failed, the cause and the action taken. For alerts, the alert-to-action time target is 15 minutes between 07:00 and 22:00 (Bogota).
