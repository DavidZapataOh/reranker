import { check, sleep } from "k6";
import http from "k6/http";
import { baseUrl, params } from "../lib/target.js";
import { latency } from "../lib/thresholds.js";

// Nominal: 50 visitors each loading the page once per second, about 50 requests per second.
const NOMINAL_VUS = 50;
const SCENARIO = __ENV.SCENARIO || "nominal";

const scenarios = {
  nominal: {
    options: { executor: "constant-vus", vus: NOMINAL_VUS, duration: "1m" },
    // A protection redirect is not an HTTP failure to k6, so the 200 check counts too.
    thresholds: { ...latency({ p95Ms: Number(__ENV.P95_MS || 800) }), checks: ["rate>0.99"] },
  },
  // An open model holds 10× the nominal rate even if responses slow down, where more VUs
  // would just wait longer. The landing is static on Vercel's edge: it keeps answering or
  // the edge rejects with a clear 429. A 5xx, a dropped connection or unsent load fails.
  stress: {
    options: {
      executor: "constant-arrival-rate",
      rate: NOMINAL_VUS * 10,
      timeUnit: "1s",
      duration: "1m",
      preAllocatedVUs: 200,
      maxVUs: 1000,
    },
    thresholds: {
      checks: ["rate>0.99"],
      http_req_failed: ["rate<0.01"],
      dropped_iterations: [`count<${NOMINAL_VUS * 10 * 60 * 0.01}`],
    },
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
    return;
  }
  check(res, { "status 200": (r) => r.status === 200 });
  sleep(1);
}
