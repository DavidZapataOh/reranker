# Deployment check stuck

## Trigger

A production deployment stays unassigned for more than 30 minutes.

## Impact

reranker.co keeps serving the previous version.

## Diagnose

```bash
gh run list --workflow ci --commit <sha>
```

- Check that every required check name exists on the commit: `ci / ci`, `ci / security`, plus the ones added by later workflows.
- Check GitHub status for Actions outages.
- If `ci / ci` failed in the remote cache step with "HTTP 400 Not authorized", the Vercel team is missing the Turborepo CLI OIDC policy for `DavidZapataOh/reranker`. Add it and rerun with `gh run rerun <id> --failed`.

## Mitigate

- Re-run the run: `gh run rerun <id> --failed`.
- If a job was renamed, update the required list in Vercel, Settings, Deployment Checks.
- Force Promote only with the CI green locally: `pnpm check && pnpm typecheck && pnpm test`.

## Verify

```bash
vercel inspect https://reranker.co
```

The output shows the new deployment.

## Record

Required. Date, commit SHA, the failing or missing check, the action taken, commands run locally if Force Promote was used, and who promoted.
