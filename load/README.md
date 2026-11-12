# Load tests

[k6](https://grafana.com/docs/k6/latest/) scenarios, run on demand against preview deployments. Production is never a target.

## Convention

- One file per scenario: `load/<area>/<scenario>.js`. `load/lib/` holds the shared helpers and is never run.
- `options.thresholds` come from the owning feature's performance budget, built with `latency({ p95Ms, errorRate })` from `lib/thresholds.js`. A breached threshold makes `k6 run` exit non-zero.
- `options.scenarios` goes through `only()` from `lib/scenarios.js` and declares two entries:
  - `nominal`: the expected peak rate.
  - `stress`: 10× that rate, selected with `-e SCENARIO=stress`. Its checks and thresholds assert the behavior the feature declares under overload: it queues, answers a clear `429`, or degrades with notice. It never errors out.
- Requests use `baseUrl()` and `params()` from `lib/target.js`: the deployment origin from `TARGET_URL` and the Vercel protection bypass header. Redirects are not followed, so the header never leaves the deployment.
- Features with a backend run their scenarios, nominal and stress, before shipping and record the result in their plan.

## Running

From GitHub Actions (preferred: the bypass secret stays in the repository):

```bash
gh workflow run load.yml -f target_url=https://<preview>.vercel.app -f scenario_glob='load/web/*.js'
gh workflow run load.yml -f target_url=https://<preview>.vercel.app -f scenario_glob='load/**/*.js' -f scenario=stress
```

`p95_ms` overrides the scenarios' p95 budget. The job refuses `https://reranker.co` and any host outside this project's previews before k6 starts. Each scenario's end-of-test summary is uploaded as the `load-summaries` artifact for 3 days.

Locally, against a preview you can open, or against `next start` on your machine:

```bash
TARGET_URL=http://localhost:3000 k6 run load/web/landing.js
```
