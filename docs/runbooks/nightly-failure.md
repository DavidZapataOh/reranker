# Nightly failure

## Trigger

An open issue labelled `nightly-failure` gets created or commented, or the Better Stack `nightly` heartbeat goes missing.

## Impact

Something that per-change checks skip broke: a provider contract, a test outside the affected packages, a flaky end-to-end test or the production site on Safari. A smoke test that fails without `flaky` means reranker.co itself may be broken: open it first.

## Diagnose

```bash
gh run view <run id> --log-failed
gh run download <run id> --name nightly-report
```

- `contract` red: a provider sandbox changed its response, rejected the credentials or a repository secret is missing (the error names the variable).
- `full` red with `flaky` in the Playwright summary: a test only passed on retry. Open `playwright-report/index.html` from the artifact and read the trace of the failed attempt.
- `full` red without `flaky`: a real failure. Check whether `main` changed since the last green night (`gh run list --workflow nightly.yml`).
- `full` red before the tests: the Neon CI branch could not be created. See the `neon-ci-branch` step output and `neonctl branches list --project-id <nonprod>`.
- A job shows `cancelled`: someone cancelled the run or it timed out. The night did not run fully either way; rerun it.
- No issue but the heartbeat is missing: the run did not start or the `report` job failed. Check `gh run list --workflow nightly.yml` and GitHub status.

## Mitigate

- Flaky test: quarantine it with `test.fixme()` in a pull request and open an issue labelled `flaky` that links the run. Fix it or delete it within 7 days.
- Contract failure: open an issue for that provider's adapter with the request and response from the log. If a secret is missing, add it with `gh secret set <NAME>`.
- Real failure: fix forward or revert the commit on `main`, as for any red check.
- Rerun once fixed:

```bash
gh workflow run nightly.yml
gh run watch
```

## Verify

The rerun is green and the heartbeat reports up in Better Stack. Close the `nightly-failure` issue with a link to the green run.

## Record

Required. In the issue: the failing job and test, the cause, the action taken (quarantine, adapter issue, fix or revert) and the link to the green run.
