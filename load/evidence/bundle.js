import { check } from "k6";
import http from "k6/http";
import { Trend } from "k6/metrics";
import { baseUrl, functionRegion, params } from "../lib/target.js";
import { latency } from "../lib/thresholds.js";

// One probe of 100 verification bundles in a row over a throwaway log of millions of entries on
// the preview's database and evidence bucket, timed inside the deployment (iad1) so the runner's
// distance to Vercel stays out of the number.
// The budget is the evidence plan's: buildBundle p95 < 250 ms.
const BUNDLES = 100;
const BUNDLE_P95_MS = 250;
// A pass builds two bundles' worth of reads plus a report's seal summaries; seeding the log and
// deleting it come on top, once.
const PASS_MS = 1000;
const SETUP_MS = 60_000;
const SCENARIO = __ENV.SCENARIO || "nominal";

const bundleMs = new Trend("evidence_bundle_ms", true);
const summariesMs = new Trend("evidence_seal_summaries_ms", true);
const budgets = {
  checks: ["rate>0.99"],
  evidence_bundle_ms: [`p(95)<${BUNDLE_P95_MS}`],
};

const scenarios = {
  nominal: {
    bundles: BUNDLES,
    options: { executor: "per-vu-iterations", vus: 1, iterations: 1, maxDuration: "5m" },
    thresholds: {
      ...latency({ p95Ms: Number(__ENV.P95_MS || SETUP_MS + (BUNDLES + 1) * PASS_MS) }),
      ...budgets,
    },
  },
  // Ten probes at once, as ten verification pages opening together: the database and R2 are
  // shared, so each bundle must still hold its budget.
  stress: {
    bundles: BUNDLES / 5,
    options: { executor: "per-vu-iterations", vus: 10, iterations: 1, maxDuration: "5m" },
    thresholds: { http_req_failed: ["rate<0.01"], ...budgets },
  },
};

const selected = Object.hasOwn(scenarios, SCENARIO) ? scenarios[SCENARIO] : undefined;
if (!selected) {
  throw new Error(
    `SCENARIO must be one of ${Object.keys(scenarios).join(", ")}, got "${SCENARIO}"`,
  );
}

export const options = {
  scenarios: { [SCENARIO]: selected.options },
  thresholds: selected.thresholds,
};

const cronSecret = __ENV.CRON_SECRET;
if (!cronSecret) throw new Error("CRON_SECRET of the preview is required");
const target = params();
const requestParams = {
  ...target,
  headers: {
    ...target.headers,
    Authorization: `Bearer ${cronSecret}`,
    "Content-Type": "application/json",
  },
  timeout: "300s",
};
const url = `${baseUrl()}/api/internal/jobs-latency`;
const body = JSON.stringify({ probe: "bundle", n: selected.bundles });

export default function () {
  const res = http.post(url, body, requestParams);
  const report = res.status === 200 ? res.json() : undefined;
  if (report) {
    // The probe's reads share one transaction; a real bundle opens two, so their cost is added.
    bundleMs.add(report.buildBundle.p95 + 2 * report.transaction.p95);
    summariesMs.add(report.sealSummaries.p95 + report.transaction.p95);
  }
  console.log(
    `bundle status=${res.status} ${JSON.stringify(report ?? null)} x-vercel-id=${res.headers["X-Vercel-Id"]}`,
  );
  check(res, {
    measured: () => report !== undefined,
    "ran in iad1": (r) => functionRegion(r) === "iad1",
  });
}
