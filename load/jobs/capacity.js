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

// The budget is p95 < 25 ms per primitive from iad1, read from the timings the
// deployment reports; the HTTP budget only adds the hold and the function around it.
const PRIMITIVE_P95_MS = 25;
const slotMs = new Trend("jobs_acquire_slot_ms", true);
const reserveMs = new Trend("jobs_reserve_spend_ms", true);
const settleMs = new Trend("jobs_settle_spend_ms", true);

// The longest a stress iteration can take: the inline wait, a last lock wait that starts just
// before it ends, the hold, then settle, release and the round trip from the runner.
const STRESS_RATE = 160;
const INLINE_WAIT_MS = 5000;
const LOCK_WAIT_MS = 2000;
const WORST_ITERATION_S = (INLINE_WAIT_MS + LOCK_WAIT_MS + HOLD_MS + 500) / 1000;
const STRESS_VUS = STRESS_RATE * WORST_ITERATION_S;

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
      rate: STRESS_RATE,
      timeUnit: "1s",
      duration: "1m",
      // Little's law: every VU the arrivals need exists before the first one. VUs allocated
      // mid-run come too late, and the arrivals they miss are dropped load the run never sent.
      preAllocatedVUs: STRESS_VUS,
      maxVUs: STRESS_VUS,
    },
    thresholds: {
      checks: ["rate>0.99"],
      http_req_failed: ["rate<0.01"],
      dropped_iterations: [`count<${STRESS_RATE * 60 * 0.01}`],
      // Budgets that always hold, so the summary reports every status the deployment answered.
      ...Object.fromEntries(
        [200, 429, 500, 503, 504].map((status) => [`http_reqs{status:${status}}`, ["count>=0"]]),
      ),
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

const requestId = (res) => res.headers["X-Vercel-Id"] ?? "none";

// One probe before the load: a target that cannot answer it, such as a preview whose database
// branch is gone or a wrong secret, stops the run with its status instead of failing every request.
export function setup() {
  const res = http.post(url, body, requestParams);
  if (res.status !== 200 && res.status !== 429) {
    throw new Error(`The target answered the first probe ${res.status} (${requestId(res)})`);
  }
  console.log(`Target ready: ${res.status} from the function in ${functionRegion(res)}`);
}

export default function () {
  const res = http.post(url, body, requestParams);
  // The request id finds the function's logs: `vercel logs --query 'requestId:"<id>"'`.
  if (res.status !== 200 && res.status !== 429) {
    console.warn(`Unexpected ${res.status} (${requestId(res)}) ${res.error}`);
  }
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
