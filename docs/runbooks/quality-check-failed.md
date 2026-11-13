# Quality check failed

## Trigger

The `quality` commit status is red (`failure` or `error`) on a commit of `main`, and Vercel holds that production deployment: reranker.co is not assigned to it. A red `quality (preview)` on a pull request blocks nothing by itself; fix it before merging with the same steps.

## Impact

reranker.co keeps serving the previous production deployment until `quality` is green on a newer commit or the deployment is force promoted. Users see no broken page, but nothing else from `main` reaches them.

## Diagnose

Open the run from the `quality` status on the commit (its link points to the run), or:

```bash
gh run list --workflow quality.yml --commit <sha>
gh run view <run id> --log-failed
gh run download <run id> --name quality-report
```

The artifact holds `playwright-report/` (open `index.html`), `test-results/` with traces (`pnpm --filter web exec playwright show-trace <trace.zip>`), `results.json` and `.lighthouseci/`.

- `Refuse untrusted deployment targets` failed: the deployment URL is not one of the project's. Nothing was tested and no secret was sent; check the payload in the run log before anything else.
- `End-to-end and accessibility tests` failed: a regression in the deployed page, an axe violation (the report names the rule and the element) or, in production only, a WebKit-specific failure.
- `Lighthouse budgets` failed: `.lighthouseci/assertion-results.json` names the route and the assertion. `resource-summary:script:size` or `total:size` means the page got heavier than its budget in `apps/web/lighthouse.ts`; a category score means accessibility, best practices or SEO dropped.
- The run was cancelled or timed out (status `error`): rerun it before reading anything into it.

## Mitigate

- Default: revert the commit on `main` through a pull request. The revert deploys and, when its `quality` is green, Vercel assigns reranker.co to it.
- Fix forward only when the fix is small and clear; it goes through a pull request with green checks like any change.
- A budget is raised only on purpose: the pull request that raises it says why the page needs the extra bytes.
- Rerun against the same deployment once the cause is outside the code (a provider or GitHub outage):

```bash
gh workflow run quality.yml -f url=<deployment url> -f environment=production -f sha=<sha>
gh run watch
```

- Force Promote only as `deployment-check-stuck.md` describes, with its local checks green and recorded.

## Verify

`quality` is green on the commit that should be live, and:

```bash
vercel inspect https://reranker.co
curl -sI https://reranker.co
```

show that deployment serving reranker.co.

## Record

Required. Date, commit SHA, run link, the failing step and assertion, the action taken (revert, fix forward, rerun or Force Promote) and the pull request.
