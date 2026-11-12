# Load tests

[k6](https://grafana.com/docs/k6/latest/) scenarios that run on demand against a Vercel preview, never against reranker.co.

## Convention

- One file per scenario: `load/<area>/<scenario>.js`. `load/lib/` holds shared helpers and is never run.
- Each scenario exports `options` with:
  - a `nominal` profile whose `thresholds` come from the budget its owning plan declares, built with `latency({ p95Ms, errorRate })` from `lib/thresholds.js`;
  - a `stress` profile at 10× the nominal rate, selected with `SCENARIO=stress`, on an arrival-rate executor so the rate holds even when responses slow down, whose thresholds check the behavior the plan declares under overload: it queues, answers a clear 429, or degrades with notice. It never fails silently.
- Requests go to `baseUrl()` with `params()` from `lib/target.js`. `params()` carries the Vercel protection bypass header and does not follow redirects, so the secret never leaves the deployment.
- Every plan with a backend adds its scenario here and records the result of a run before it ships.

## Run in CI

```bash
gh workflow run load.yml -f target_url=<preview URL> -f scenario_glob='load/web/*.js'
gh workflow run load.yml -f target_url=<preview URL> -f scenario_glob='load/web/*.js' -f scenario=stress
gh workflow run load.yml -f target_url=<preview URL> -f scenario_glob='load/web/landing.js' -f p95_ms=500
```

The job refuses any URL that is not a preview of this project before k6 starts. Each scenario writes `summary-<area>-<scenario>.json` to the `load-results` artifact (kept 3 days). A scenario that misses a threshold fails the run; the others still run.

## Run locally

```bash
TARGET_URL=<preview URL> VERCEL_AUTOMATION_BYPASS_SECRET=<secret> k6 run load/web/landing.js
```

Use a preview URL or a local `next start`. Never point it at reranker.co: the load lands on real users.
