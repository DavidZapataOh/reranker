import { check } from "k6";
import http from "k6/http";
import { Trend } from "k6/metrics";
import { baseUrl, functionRegion, params } from "../lib/target.js";
import { latency } from "../lib/thresholds.js";

// One probe of 1,000 datacenter and VPN lookups in a row, timed inside the deployment (iad1, next
// to Neon us-east-1) so the runner's distance to Vercel stays out of the number.
const LOOKUPS = 1000;
const LOOKUP_P95_MS = 10;
// The live lists hold over 40,000 prefixes; fewer means the preview database never loaded them.
const MIN_RANGES = 40_000;
const SCENARIO = __ENV.SCENARIO || "nominal";

const lookupMs = new Trend("jobs_classify_network_ms", true);
const shared = {
  checks: ["rate>0.99"],
  jobs_classify_network_ms: [`p(95)<${LOOKUP_P95_MS}`],
};

const scenarios = {
  nominal: {
    options: { executor: "per-vu-iterations", vus: 1, iterations: 1, maxDuration: "5m" },
    // Every lookup within budget keeps the whole probe within 1,000 of them.
    thresholds: {
      ...latency({ p95Ms: Number(__ENV.P95_MS || LOOKUPS * LOOKUP_P95_MS) }),
      ...shared,
    },
  },
  // Ten probes at once: the lookup is a read on a GiST index, so it holds its budget under 10×.
  stress: {
    options: { executor: "per-vu-iterations", vus: 10, iterations: 1, maxDuration: "5m" },
    thresholds: { http_req_failed: ["rate<0.01"], ...shared },
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
const body = JSON.stringify({ probe: "network", n: LOOKUPS });

export default function () {
  const res = http.post(url, body, requestParams);
  const report = res.status === 200 ? res.json() : undefined;
  if (report) {
    lookupMs.add(report.classifyNetwork.p95);
    console.log(
      `classifyNetwork ${JSON.stringify(report)} x-vercel-id=${res.headers["X-Vercel-Id"]}`,
    );
  }
  check(res, {
    measured: () => report !== undefined,
    "ran in iad1": (r) => functionRegion(r) === "iad1",
    "lists loaded": () => report !== undefined && report.ranges >= MIN_RANGES,
  });
}
