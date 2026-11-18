# Load tests

[k6](https://grafana.com/docs/k6/latest/) scenarios that run on demand against a Vercel preview, never against reranker.co.

## Convention

- One file per scenario: `load/<area>/<scenario>.js`. `load/lib/` holds shared helpers and is never run.
- Each scenario exports `options` with:
  - a `nominal` profile whose `thresholds` come from the budget its owning plan declares, built with `latency({ p95Ms, errorRate })` from `lib/thresholds.js`;
  - a `stress` profile at 10× the nominal rate, selected with `SCENARIO=stress`, on an arrival-rate executor so the rate holds even when responses slow down, whose thresholds check the behavior the plan declares under overload: it queues, answers a clear 429, or degrades with notice. It never fails silently.
- Requests go to `baseUrl()` with `params()` from `lib/target.js`. `params()` carries the Vercel protection bypass header and does not follow redirects, so the secret never leaves the deployment.
- Every plan with a backend adds its scenario here and records the result of a run before it ships.
- Scenarios that call internal routes (`/api/internal/*`) send `CRON_SECRET`, which CI takes from the `PREVIEW_CRON_SECRET` repository secret; it must hold the value of `CRON_SECRET` in Vercel's Preview environment.

## Scenarios

| Scenario | What it loads | Budget |
|---|---|---|
| `web/landing.js` | The landing page | p95 < 800 ms; 10×: served or 429 |
| `jobs/capacity.js` | 10 free reports at once: 1,200 DataForSEO slots, each with a contract-test reservation settled at zero | p95 < 25 ms per primitive; 10×: admitted or 429 with `Retry-After`, never a 5xx |
| `jobs/network.js` | 1,000 datacenter and VPN lookups in a row, timed inside the deployment | p95 < 10 ms per lookup over the live lists; 10×: ten probes at once hold the same budget |

## Run in CI

```bash
gh workflow run load.yml -f target_url=<preview URL> -f scenario_glob='load/web/*.js'
gh workflow run load.yml -f target_url=<preview URL> -f scenario_glob='load/web/*.js' -f scenario=stress
gh workflow run load.yml -f target_url=<preview URL> -f scenario_glob='load/web/landing.js' -f p95_ms=500
```

The job refuses any URL that is not a preview of this project before k6 starts. A preview's database branch is deleted when its pull request closes, so only the latest preview of an open pull request can answer; `jobs/capacity.js` stops at its first probe otherwise. Its summary counts each status the deployment answered, and every unexpected answer is logged with its `x-vercel-id`, whose last part is the request id that `vercel logs --query 'requestId:"<id>"'` finds. Each scenario writes `summary-<area>-<scenario>.json` to the `load-results` artifact (kept 3 days). A scenario that misses a threshold fails the run; the others still run.

## Run locally

```bash
TARGET_URL=<preview URL> VERCEL_AUTOMATION_BYPASS_SECRET=<secret> k6 run load/web/landing.js
TARGET_URL=<preview URL> VERCEL_AUTOMATION_BYPASS_SECRET=<secret> CRON_SECRET=<preview secret> k6 run load/jobs/capacity.js
TARGET_URL=<preview URL> VERCEL_AUTOMATION_BYPASS_SECRET=<secret> CRON_SECRET=<preview secret> k6 run load/jobs/network.js
```

Use a preview URL or a local `next start`. Never point it at reranker.co: the load lands on real users.
