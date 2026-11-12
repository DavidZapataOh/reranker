import { check, sleep } from "k6";
import http from "k6/http";
import { baseUrl, params } from "../lib/target.js";
import { latency } from "../lib/thresholds.js";

// One visit per second per user: 50 users is the nominal rate, stress is 10× that.
const NOMINAL_VUS = 50;
const SCENARIO = __ENV.SCENARIO || "nominal";

const scenarios = {
  nominal: {
    options: { executor: "constant-vus", vus: NOMINAL_VUS, duration: "1m" },
    // A protection redirect is not an HTTP failure to k6, so the 200 check counts too.
    thresholds: { ...latency({ p95Ms: Number(__ENV.P95_MS || 800) }), checks: ["rate>0.99"] },
  },
  // The landing is static and served from Vercel's edge: at 10× it keeps answering, or
  // the edge rejects with a clear 429. A 5xx or a dropped connection is a failure.
  stress: {
    options: { executor: "constant-vus", vus: NOMINAL_VUS * 10, duration: "1m" },
    thresholds: { checks: ["rate>0.99"], http_req_failed: ["rate<0.01"] },
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

const url = `${baseUrl()}/`;
const requestParams = params();

if (SCENARIO === "stress") http.setResponseCallback(http.expectedStatuses(200, 429));

export default function () {
  const res = http.get(url, requestParams);
  if (SCENARIO === "stress") {
    check(res, { "served or rejected with 429": (r) => r.status === 200 || r.status === 429 });
  } else {
    check(res, { "status 200": (r) => r.status === 200 });
  }
  sleep(1);
}
