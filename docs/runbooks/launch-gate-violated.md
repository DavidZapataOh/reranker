# Launch gate violated

## Trigger

The `launch-gate-violated` alert (source `launch`), raised by the `launchGate` step of the daily maintenance run (05:00 Bogota) when `free-report-live` or `accounts` is on in production while a provider stage that flag needs does not pass `launch:check`. A failing check makes it critical (emailed); a check that could only be marked unknown (missing credential, provider not answering) sends it as a warning. The payload carries `flag`, `failing` and `unknown` (check ids) and `reasons`.

`pnpm flags:sync --enable <flag>` refuses to turn a gated flag on while a check fails, so this alert means the flag was turned on another way (the PostHog UI) or a stage regressed after it went on.

Stages each flag needs (the source of truth is `LAUNCH_GATES` in `packages/telemetry/src/launch/types.ts`):

| Check | Stage | `accounts` | `free-report-live` |
|---|---|---|---|
| `neon-production` | `reranker-prod` always on (scale to zero off), 0.5–4 CU, 7 days of history, protected default branch | yes | yes |
| `resend-plan` | Resend Pro: no Free daily quota header, `QUOTA_RESEND_EMAILS_HOURLY_FLOOR` unset or at least 500 | yes | yes |
| `resend-sending-key` | Production `RESEND_API_KEY` is a sending-only key | | yes |
| `betterstack-ready` | A Better Stack monitor on `https://reranker.co/api/ready`, every 30 s, paging the on-call person | | yes |
| `betterstack-routing` | An incoming webhook that pages the on-call person for critical alerts | | yes |
| `posthog-billing` | PostHog pay-as-you-go and `POSTHOG_PLAN=pay-as-you-go` | | yes |
| `posthog-projects` | Production on its own PostHog project, another one for previews | | yes |
| `github-private-org` | The repository is private and owned by an organization | | yes |
| `traces` | A tracer provider registered with `@vercel/otel` | | yes |
| `smoke-cron` | A `/api/cron/smoke` cron every 15 minutes in `apps/web/vercel.json` | | yes |
| `spend-caps` | Free report cap at least US$200 and every `provider:*` cap at least what its purposes can spend on it × 1.2 (`providerCapFloor`); read from the deployment, so it is reported but gates no flag | | |

## Impact

Real users are on a path whose provider tier was not verified: a cold Neon start against a 2 s timeout, sign-in codes cut at Resend Free's 100 a day, an outage nobody is paged for, or thresholds readable in a public repository, depending on the stage.

## Diagnose

Run the check with the production environment and read each line:

```bash
vercel env pull .env.production.local --environment=production
pnpm launch:check --env-file=.env.production.local
```

- `fail`: the stage is not done; the reason names the setting.
- `unknown`: the check could not read the provider (missing credential, an HTTP error, no answer in 10 s). The reason says which. A missing credential is listed in `packages/env/src/catalog.ts`.

Delete `.env.production.local` when done.

## Mitigate

1. Turn the flag off in PostHog (Feature flags, the flag, Disable) unless the failing stage cannot hurt users today; turning it off is safe and takes effect within 60 s.
2. Complete the stage the reason names, in the provider's console: Neon (Branches, Computes, Edit; Settings, Instant restore), Resend (Billing; API Keys, Sending access), Better Stack (Monitors; Integrations, Incoming webhook), PostHog (Billing; Projects), GitHub (Settings, Transfer to the organization; Change visibility), Vercel (`vercel.json` crons, instrumentation).
3. Turn the flag back on through the gate: `pnpm flags:sync --enable <flag>` with the production environment, as in Diagnose. It refuses while any check is not `pass`.

## Verify

`pnpm launch:check` shows every check of the flag as `pass`, and the next daily run raises no `launch-gate-violated`.

## Record

In the alert thread or the pull request: the flag, the checks that failed and why, whether the flag was turned off, and the date each stage was completed.
