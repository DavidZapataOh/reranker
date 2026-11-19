# Nightly failure

## Trigger

An open issue labeled `nightly-failure`, or Better Stack reports the nightly heartbeat missing. Each failing contract package (`Nightly contract: @reranker/<package>#test:contract`) or full-suite gate (`Nightly full: <gate>`) has its own issue; a job that was cancelled or timed out opens `Nightly <job>: job <result>`. The weekly `measure` workflow files `Weekly measure: places region bias` under the same label when searching without a region code finds businesses 5 or more points less often than with it; rerun it with `gh workflow run measure.yml`. Every red night after the first adds a comment to the issue of the same failure. Only scheduled or dispatched runs on `main` touch issues; a run on another branch writes its failures to the run summary.

## Impact

Nothing is blocked: the nightly gates no deployment. It is the only run of the provider contract tests, the uncached full suite and the strict smoke suite on reranker.co, so until it is green a provider change or a flaky test can reach users unnoticed.

## Diagnose

```bash
gh issue list --label nightly-failure --state open
gh run view <run id> --log-failed
gh run download <run id> --name nightly-report
```

- `contract` failed: a provider changed its API, its sandbox is down, or a secret is missing or expired. Every package runs even after one fails, so the issue titles list each broken adapter; the test name in the log tells which one. `Missing required environment variable X` means the GitHub secret mapped to `X` in `nightly.yml` is absent; `pnpm secrets:audit` lists the missing ones.
- `full` failed with a test marked `flaky` in `results.json` or the HTML report: it passed only on retry. The run fails on purpose.
- `full` failed hard in the tests or the smoke suite: a real regression on `main` or in production.
- `full` failed before the tests: no free `ci/` branch slot in `reranker-nonprod` or Neon is down. List branches with `neonctl branches list --project-id <id>` and check Neon's status page.

## Mitigate

- Flaky test: mark it `test.fixme()` in a PR and open an issue labeled `flaky` that links the run. Within 7 days it is fixed or deleted.
- Contract: check the provider's changelog and status page, then fix the adapter. Create or rotate the secret if it is missing or expired.
- Regression: revert the commit on `main` or fix forward, as with any red check.
- Rerun after the fix:

```bash
gh workflow run nightly.yml
gh run watch
```

## Verify

The rerun is green on all three jobs and Better Stack receives the heartbeat. The report job closes, with a link to the run, every issue whose package or gate passed in a job that ran to the end.

## Record

Required. In the issue, before it closes: the cause, the PR that fixed it, and the `flaky` issue if one was opened.
