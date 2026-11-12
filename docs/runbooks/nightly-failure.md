# Nightly failure

## Trigger

An open issue labeled `nightly-failure`, or Better Stack reports the nightly heartbeat missing. Every red night after the first adds a comment to the same issue.

## Impact

Nothing is blocked: the nightly gates no deployment. It is the only run of the provider contract tests, the uncached full suite and the strict smoke suite on reranker.co, so until it is green a provider change or a flaky test can reach users unnoticed.

## Diagnose

```bash
gh issue list --label nightly-failure --state open
gh run view <run id> --log-failed
gh run download <run id> --name nightly-report
```

- `contract` failed: a provider changed its API, its sandbox is down, or a secret is missing or expired. The test name tells which adapter.
- `full` failed with a test marked `flaky` in `results.json` or the HTML report: it passed only on retry. The run fails on purpose.
- `full` failed hard in the tests or the smoke suite: a real regression on `main` or in production.
- `full` failed before the tests: no free `ci/` branch slot in `reranker-nonprod` or Neon is down. List branches with `neonctl branches list --project-id <id>` and check Neon's status page.

## Mitigate

- Flaky test: mark it `test.fixme()` in a PR and open an issue labeled `flaky` that links the run. Within 7 days it is fixed or deleted.
- Contract: check the provider's changelog and status page, then open an issue for that adapter. Rotate the secret if it expired.
- Regression: revert the commit on `main` or fix forward, as with any red check.
- Rerun after the fix:

```bash
gh workflow run nightly.yml
gh run watch
```

## Verify

The rerun is green on all three jobs and Better Stack receives the heartbeat. Close the `nightly-failure` issue with a link to that run.

## Record

Required. In the issue: the cause, the PR that fixed it, and the `flaky` or adapter issue if one was opened.
