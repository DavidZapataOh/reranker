import { check } from "k6";
import http from "k6/http";
import { Trend } from "k6/metrics";
import { baseUrl, functionRegion, params } from "../lib/target.js";
import { latency } from "../lib/thresholds.js";

// Ten free reports at once, each admitting 120 provider calls: 1,200 DataForSEO slots taken,
// each with a contract-test reservation settled at zero, so nothing is spent. Every request is
// one admission that keeps its slot for HOLD_MS, standing in for the provider call.
const REPORTS = 10;
const CALLS_PER_REPORT = 120;
const HOLD_MS = 500;
const SCENARIO = __ENV.SCENARIO || "nominal";

// The plan's budget is p95 < 25 ms per primitive from iad1, read from the timings the
// deployment reports; the HTTP budget only adds the hold and the function around it.
const PRIMITIVE_P95_MS = 25;
const slotMs = new Trend("jobs_acquire_slot_ms", true);
const reserveMs = new Trend("jobs_reserve_spend_ms", true);
const settleMs = new Trend("jobs_settle_spend_ms", true);

const scenarios = {
  nominal: {
    options: {
      executor: "per-vu-iterations",
      vus: REPORTS,
      iterations: CALLS_PER_REPORT,
      maxDuration: "5m",
    },
    thresholds: {
      ...latency({ p95Ms: Number(__ENV.P95_MS || HOLD_MS + 500) }),
      checks: ["rate>0.99"],
      jobs_acquire_slot_ms: [`p(95)<${PRIMITIVE_P95_MS}`],
      jobs_reserve_spend_ms: [`p(95)<${PRIMITIVE_P95_MS}`],
      jobs_settle_spend_ms: [`p(95)<${PRIMITIVE_P95_MS}`],
    },
  },
  // Ten times the nominal arrival rate (about 16 admissions per second) on an open model, so
  // demand outruns DataForSEO's 28 slots. Admission queues for up to the inline wait and then
  // answers a clear 429 with Retry-After, the delay a durable step would retry at. A 5xx, a
  // dropped connection or unsent load fails.
  stress: {
    options: {
      executor: "constant-arrival-rate",
      rate: 160,
      timeUnit: "1s",
      duration: "1m",
      preAllocatedVUs: 300,
      maxVUs: 1200,
    },
    thresholds: {
      checks: ["rate>0.99"],
      http_req_failed: ["rate<0.01"],
      dropped_iterations: [`count<${160 * 60 * 0.01}`],
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
};
const url = `${baseUrl()}/api/internal/jobs-latency`;
const body = JSON.stringify({ n: 1, holdMs: HOLD_MS });

if (SCENARIO === "stress") http.setResponseCallback(http.expectedStatuses(200, 429));

export default function () {
  const res = http.post(url, body, requestParams);
  if (res.status === 200) {
    const report = res.json();
    slotMs.add(report.acquireProviderSlot.p50);
    reserveMs.add(report.reserveSpend.p50);
    settleMs.add(report.settleSpend.p50);
  }
  if (SCENARIO === "stress") {
    check(res, {
      "admitted, or told when to retry": (r) =>
        r.status === 200 || (r.status === 429 && Number(r.headers["Retry-After"]) > 0),
    });
    return;
  }
  check(res, {
    admitted: (r) => r.status === 200,
    // The budgets hold only next to the database.
    "ran in iad1": (r) => functionRegion(r) === "iad1",
  });
}
