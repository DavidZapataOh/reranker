import { check } from "k6";
import http from "k6/http";
import { Trend } from "k6/metrics";
import { baseUrl, functionRegion, params } from "../lib/target.js";
import { latency } from "../lib/thresholds.js";

// One probe of 100 capture seals in a row against the preview's R2 buckets, database and KMS key,
// timed inside the deployment (iad1) so the runner's distance to Vercel and R2 stays out of the
// number. The budget is the evidence plan's: sealCapture p95 < 400 ms.
const SEALS = 100;
const SEAL_P95_MS = 400;
// KMS Sign's own p95 budget. Until the preview has a capture key the probe cannot sign, so the
// parts it can time must leave this much of the seal budget for the signature.
const KMS_SIGN_P95_MS = 40;
// A pass seals once, writes one more round of the same objects and deletes both, each within the
// seal budget, plus the transaction and envelope beside them.
const PASS_MS = 1500;
const SCENARIO = __ENV.SCENARIO || "nominal";

const sealMs = new Trend("evidence_seal_ms", true);
const unsignedMs = new Trend("evidence_seal_unsigned_ms", true);
const budgets = {
  checks: ["rate>0.99"],
  evidence_seal_ms: [`p(95)<${SEAL_P95_MS}`],
  evidence_seal_unsigned_ms: [`p(95)<${SEAL_P95_MS - KMS_SIGN_P95_MS}`],
};

const scenarios = {
  nominal: {
    seals: SEALS,
    options: { executor: "per-vu-iterations", vus: 1, iterations: 1, maxDuration: "5m" },
    thresholds: {
      ...latency({ p95Ms: Number(__ENV.P95_MS || (SEALS + 1) * PASS_MS) }),
      ...budgets,
    },
  },
  // Ten probes at once, as ten free reports sealing their captures together: R2 and KMS are
  // shared, so each seal must still hold its budget.
  stress: {
    seals: SEALS / 5,
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
const body = JSON.stringify({ probe: "seal", n: selected.seals });

export default function () {
  const res = http.post(url, body, requestParams);
  const report = res.status === 200 ? res.json() : undefined;
  if (report) {
    if (report.sealCapture) {
      sealMs.add(report.sealCapture.p95);
    } else {
      console.warn("No capture key in this preview yet: the seal and KMS Sign are not measured");
    }
    // Added up, their p95s stand in conservatively for a seal without its signature: the seal
    // overlaps the envelope write with the others, the sum does not.
    unsignedMs.add(report.r2WriteRound.p95 + report.database.p95 + report.envelope.p95);
  }
  console.log(
    `seal status=${res.status} ${JSON.stringify(report ?? null)} x-vercel-id=${res.headers["X-Vercel-Id"]}`,
  );
  check(res, {
    measured: () => report !== undefined,
    "ran in iad1": (r) => functionRegion(r) === "iad1",
  });
}
