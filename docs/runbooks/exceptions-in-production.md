# Exceptions in production

## Trigger

One of the three PostHog insight alerts, delivered by email (and in-app) to the subscribed users. Each checks a saved SQL insight on production events only (`properties.app_env = 'production'`):

- `Error en reranker.co`: any `$exception` in the last hour. Checked hourly.
- `Alertas de operación`: any `ops_alert` event in the last hour, meaning the application already raised one of its own alerts. Checked hourly.
- `LCP p75 alto`: the 75th percentile of Largest Contentful Paint (`$web_vitals`) over 7 days is above 2500 ms. Checked daily.

The definitions live in `packages/telemetry/posthog-alerts.json` and are applied with `alerts:apply`; changing an alert in the PostHog UI is overwritten by the next apply.

## Impact

- Exceptions: some request, page or background job failed and its owner saw an error. Volume decides the scope: one event is a single visitor, a burst after a deploy is that deploy.
- Operation alerts: a monitored resource crossed its limit; the alert email names the `kind` and links its own runbook.
- LCP: real visitors on the landing wait too long for the main content. Nothing is broken, but conversion drops.

## Diagnose

Exceptions:

- Open Error tracking in PostHog, filter by environment `production` and the last hour. The newest issue shows the scrubbed stack, the route and the `request_id`.
- Match the first occurrence against the deployments to see whether it started with one.

```bash
vercel ls --prod
vercel logs <production deployment url> --since 2h
```

Operation alerts: open the `ops_alert` events in PostHog; the `kind` property selects the runbook to follow.

LCP:

- In PostHog Web analytics, Web vitals, split by path and device. A single page or device class is a regression in that page; every page is infrastructure or a heavy third-party script.
- Compare with the last deployment that touched the landing and with the Lighthouse run of the quality workflow.

To confirm the whole path works end to end, trigger a controlled error:

```bash
curl -si -H "Authorization: Bearer $CRON_SECRET" "https://reranker.co/api/ops/fault?kind=handler"
```

The exception appears in Error tracking within minutes and the next hourly check fires `Error en reranker.co`.

## Mitigate

- A deploy caused it: roll back to the previous production deployment, then fix forward.

```bash
vercel rollback
```

- A provider caused it: the provider's kill switch flag stays off until the provider recovers; see the runbook of the `kind` in the alert.
- LCP: revert or defer the change that added weight to the first screen; do not raise the threshold to silence it.

## Verify

The next scheduled check reports the alert as not firing: `Error en reranker.co` and `Alertas de operación` within an hour after the last exception, `LCP p75 alto` after seven days of data below the limit or one daily check once the percentile is back under 2500 ms.

```bash
pnpm --filter @reranker/telemetry alerts:apply --dry-run
```

The dry run prints `nothing to do` when PostHog still matches the definitions.

## Record

In the pull request that fixes it: the cause, the first affected deployment and the fix. If a threshold or query changes, edit `packages/telemetry/posthog-alerts.json` and run `alerts:apply` in the same change.

## Applying the definitions

`alerts:apply` needs a personal API key (`POSTHOG_PERSONAL_API_KEY`) with the scopes `insight:read`, `insight:write`, `alert:read` and `alert:write`. The key is temporary and can be deleted after the run. The PostHog free plan allows 5 insight alerts in the organization: the tool counts every alert in the project and refuses to create one that would pass 5.

Web vitals also need the project setting "Web vitals autocapture" enabled in PostHog (Project settings, Autocapture) in addition to the client option.
