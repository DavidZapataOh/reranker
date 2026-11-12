# Load tests

[k6](https://grafana.com/docs/k6/latest/) scenarios, run on demand against preview deployments. Production is never a target.

## Convention

- One file per scenario: `load/<area>/<scenario>.js`. `load/lib/` holds the shared helpers and is never run.
- `options.thresholds` come from the owning feature's performance budget, built with `latency({ p95Ms, errorRate })` from `lib/thresholds.js`. A breached threshold makes `k6 run` exit non-zero.
- `options.scenarios` goes through `only()` from `lib/scenarios.js` and declares two entries:
  - `nominal`: the expected peak rate.
  - `stress`: 10× that rate, selected with `-e SCENARIO=stress`. Its checks and thresholds assert the behavior the feature declares under overload: it queues, answers a clear `429`, or degrades with notice. It never errors out.
- A feature that declares overload behavior drives both entries with an arrival-rate executor (`constant-arrival-rate` or `ramping-arrival-rate`, stress `rate` = 10 × nominal `rate`). With `constant-vus` the request rate falls as the backend slows down, so the overload never arrives. The static landing keeps `constant-vus`: it declares no overload behavior.
- When the declared behavior is a `429`, the stress run counts it as expected and asserts it is a clear one, with its own budget:

  ```js
  import http from "k6/http";
  import { Rate } from "k6/metrics";

  const stress = __ENV.SCENARIO === "stress";
  const rejected = new Rate("rejected");
  if (stress) http.setResponseCallback(http.expectedStatuses({ min: 200, max: 399 }, 429));

  // thresholds: stress ? { ...latency({ p95Ms: 1500 }), rejected: ["rate<0.5"] } : latency({ p95Ms: 300 })
  // per request: rejected.add(res.status === 429);
  //   check(res, { "429 is clear": (r) => r.status !== 429 || r.headers["Retry-After"] !== undefined });
  ```
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
