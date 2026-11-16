# Heartbeat missed

## Trigger

The `heartbeat-missed` alert, or Better Stack reports a missing heartbeat:

- `daily`: the daily job on Vercel, period 24 h, grace 2 h (Hobby crons run at any minute within the scheduled hour).
- `nightly`: the nightly GitHub workflow, period 24 h, grace 1 h.

## Impact

The job did not report that it finished, so it may not have run. Nothing user-facing is blocked.

- `daily`: no summary email was sent and the free-tier and cost checks it carries did not run that day.
- `nightly`: contract tests, the uncached full suite and the strict production smoke suite did not run; a provider change or flaky test can go unnoticed.

## Diagnose

`daily`:

```bash
vercel logs <production deployment url> --since 26h
```

- No invocation in the logs: the cron is not registered on the current deployment or Vercel skipped it; check the Crons tab of the project.
- Invocation with an error: the summary threw before pinging; the log line names the step.
- Invocation succeeded but no ping: `BETTERSTACK_HEARTBEAT_DAILY_URL` is missing, wrong or rotated.

`nightly`:

```bash
gh run list --workflow nightly.yml --limit 5
gh run view <run id> --log-failed
```

- No run: GitHub skipped the schedule (it can after 60 days without repository activity) or Actions minutes are exhausted; see the `ci-minutes-exhausted` runbook.
- Run failed before the final step: follow the `nightly-failure` runbook.
- Run green but no ping: the `BETTERSTACK_HEARTBEAT_NIGHTLY_URL` repository secret is missing or wrong.

## Mitigate

- Rerun the job once the cause is fixed.

```bash
gh workflow run nightly.yml
```

- For the daily job, redeploy production if the cron is not registered.
- A wrong heartbeat URL is replaced following `rotate-secret`.

## Verify

Better Stack shows the heartbeat as received after the rerun and the incident closes by itself; for `daily`, the summary email arrives.

## Record

In the Better Stack incident: the cause and the fix.
