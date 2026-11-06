# CI minutes exhausted

## Trigger

- GitHub email at 90% or 100% of the included Actions minutes, or
- the `free-tier-quota` alert at 50%, 80% and 95%.

## Impact

GitHub Actions is blocked until the next billing month. Vercel does not promote production deployments because the required checks (`ci / ci`, `ci / security`, `ci / integration`) never report.

## Diagnose

```bash
gh api /users/DavidZapataOh/settings/billing/usage
```

Confirm which workflows and jobs consume the most minutes before cutting anything.

## Mitigate

Apply in this order, stopping as soon as usage is back under control:

1. Reduce the `quality` workflow to Chromium only.
2. Disable the `nightly` workflow.
3. Move `security` to a weekly schedule.
4. Last resort: Force Promote the deployment in Vercel, only after `pnpm check && pnpm typecheck && pnpm test && pnpm audit --prod --audit-level high && pnpm licenses:check && gitleaks git --redact` pass locally on the exact commit.

Related setup facts, in case checks fail for reasons other than quota:

- Remote cache in CI needs the Vercel team's Turborepo CLI OIDC policy for `DavidZapataOh/reranker`. When it is missing, the `setup-turborepo-remote-cache` step fails with "HTTP 400 Not authorized". Add the policy, then `gh run rerun <id> --failed`.
- gitleaks is a standalone binary with no npm package. Install the pinned 8.30.1 release and verify its checksum; without it every commit fails at the pre-commit hook.
- Existing checkouts do not re-run lefthook's postinstall on an up-to-date `pnpm install`. Fix with `pnpm rebuild lefthook` (or `pnpm exec lefthook install`).

## Verify

- `gh api /users/DavidZapataOh/settings/billing/usage` shows usage below the limit, or the workflows run again.
- A fresh push shows `ci / ci`, `ci / security` and `ci / integration` reporting on the commit.
- If Force Promote was used: `vercel inspect https://reranker.co` shows the promoted deployment.

## Record

Date, commit SHA, commands run locally with their result, which mitigation steps were applied, and who promoted (if Force Promote was used). Revert the temporary reductions once the quota resets.
