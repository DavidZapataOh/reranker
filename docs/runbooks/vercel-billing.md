# Vercel billing

## Trigger

Any of these, whichever comes first:

1. **Primary: Better Stack.** The uptime monitors of `https://reranker.co/` and `/api/health` (and `/api/ready` once it is monitored) are `status` monitors, which only accept a 2xx answer, so a `402` is downtime: they open an incident and raise `uptime-down` (see [uptime-down.md](uptime-down.md)) within two failed checks (about 6 minutes at the current 3-minute checks, about 1 minute once `/api/ready` runs every 30 s). This is the only alert that reaches anyone while the team is blocked, so it must page the on-call person, not only email (`launch:check` verifies this as `betterstack-ready` and `betterstack-routing`).
2. **Backstop: the `vercel-billing` alert** (critical, source `vercel`), raised by the `vercelBilling` step of the daily maintenance run (05:00 Bogota) when the team `GET /v2/teams/{teamId}` returns a `softBlock` or `blocked`, the plan is not Pro or Enterprise, `billing.status` is not `active`, or `https://reranker.co/api/health` answers `402`. The payload's `reason` names which. A blocked team does not run crons either, so this step catches a plan that stopped being `active` before Vercel blocks the team; the block itself is caught by the monitors.
3. **Report:** the daily digest lists "Vercel Pro activo y al día" under "Escalones pendientes" while the check does not pass, and shows "sin verificar: falta VERCEL_BILLING_READ_TOKEN" when the token is missing. `pnpm launch:check` prints the same check from any machine and from CI.

## Impact

When Vercel blocks the team (for example `softBlock.reason` `UNPAID_INVOICE` after a failed Pro charge, with `billing.status` `canceled`), every deployment of the team answers `402 DEPLOYMENT_DISABLED`: reranker.co, the API, previews, crons and the daily run. Nothing is served and nothing scheduled runs until the invoice is paid. Data in Neon, PostHog and the other providers is untouched.

A `billing.status` other than `active` without a block yet (a failed charge being retried) serves normally, but the block follows if the payment is not fixed.

## Diagnose

```bash
curl -si https://reranker.co/api/health | head -5
curl -s -H "Authorization: Bearer $VERCEL_BILLING_READ_TOKEN" \
  https://api.vercel.com/v2/teams/team_Z821WJ1qhLyT3ohz19uC3MOm | jq '{billing, softBlock, blocked}'
```

- `402` from reranker.co: the team is disabled. The team response says why: `softBlock.reason` (`UNPAID_INVOICE`, `SUBSCRIPTION_CANCELED`, `SUBSCRIPTION_EXPIRED`, `FAIR_USE_LIMITS_EXCEEDED`, ...).
- `billing.status` not `active` and no `softBlock`: the charge failed and Vercel is retrying. Fix it now, before the block.
- `billing.plan` `hobby`: the team was downgraded. Hobby's terms forbid commercial use; move it back to Pro.
- The alert says only `reranker.co responde 402` and the token is missing: read the team in the dashboard (Settings, Billing) instead.

## Mitigate

1. Open Vercel, team `davidzapataohs-projects`, Settings, Billing. Pay the open invoice, or update the card and retry the charge.
2. If the reason is `FAIR_USE_LIMITS_EXCEEDED` or a usage pause, raise the spend limit in Settings, Billing, Spend Management, or remove the usage that hit it.
3. If the team was downgraded to Hobby, upgrade it back to Pro in the same page.
4. Wait for `curl -si https://reranker.co/api/health` to return `200`. If it still answers `402` ten minutes after the payment went through, redeploy production from the dashboard (Deployments, latest production deployment, Redeploy).

## Verify

`https://reranker.co/api/health` returns `200`, the Better Stack monitors return to up, the team response has no `softBlock` and `billing.status` `active`, and `pnpm launch:check --env-file=.env.production.local` shows `vercel-billing` as `pass`. The next daily run raises no `vercel-billing`.

## Record

In the Better Stack incident timeline: when the charge failed, when the block started and ended, the `softBlock.reason`, and what fixed it. If the card failed, note the card's expiry to renew it before it lapses again. The alert-to-action time target is 15 minutes between 07:00 and 22:00 (Bogota).
