import { check } from "k6";
import http from "k6/http";
import { Trend } from "k6/metrics";
import { baseUrl, functionRegion, params } from "../lib/target.js";
import { latency } from "../lib/thresholds.js";

// One probe of 100 capture seals in a row against the preview's R2 buckets, database and KMS key,
// timed inside the deployment (iad1) so the runner's distance to Vercel and R2 stays out of the
// number. The evidence plan's ceiling stays: sealCapture p95 < 400 ms.
const SEALS = 100;
const SEAL_P95_MS = 400;
// What a seal may cost a report. A free report must answer within 120 s at p95, and sealing may
// take at most 2% of that: 2.4 s. A report's 200 slots run on 28 workers, each of which seals a
// slot before calling the next, so a worker seals 200 / 28 ≈ 7.1 times in a row: 2.4 s / 7.1 ≈
// 336 ms for a typical seal. Its p50 is held to that; its p95 only has to stay clear of a gross
// regression, since one slow seal among seven barely moves the report.
const REPORT_P95_MS = 120_000;
const SEAL_SHARE = 0.02;
const SEALS_PER_WORKER = 200 / 28;
const SEAL_P50_MS = Math.floor((REPORT_P95_MS * SEAL_SHARE) / SEALS_PER_WORKER);
const SEAL_GROSS_P95_MS = 1000;
// KMS Sign's own p95 budget. Until the preview has a capture key the probe cannot sign, so the
// seal it can time is charged this much for the signature.
const KMS_SIGN_P95_MS = 40;
// A pass seals once, writes one more round of the same objects and deletes both, each within the
// seal budget, plus the transaction and envelope beside them.
const PASS_MS = 1500;
// A capture holds a system connection for two one-statement transactions; a report's captures
// share three connections per instance, each waited for at most two seconds.
const HOLD_P95_MS = 50;
const SCENARIO = __ENV.SCENARIO || "nominal";

const sealMs = new Trend("evidence_seal_ms", true);
// One sample per probe: its seal p50, and its seal p95.
const slotSealMs = new Trend("evidence_seal_per_slot_ms", true);
const slotSealP95Ms = new Trend("evidence_seal_per_slot_p95_ms", true);
const holdMs = new Trend("evidence_capture_hold_ms", true);
const budgets = {
  checks: ["rate>0.99"],
  evidence_seal_ms: [`p(95)<${SEAL_P95_MS}`],
  evidence_seal_per_slot_ms: [`max<${SEAL_P50_MS}`],
  evidence_seal_per_slot_p95_ms: [`max<${SEAL_GROSS_P95_MS}`],
  evidence_capture_hold_ms: [`p(95)<${HOLD_P95_MS}`],
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
      slotSealMs.add(report.sealCapture.p50);
      slotSealP95Ms.add(report.sealCapture.p95);
    } else {
      console.warn("No capture key in this preview yet: the seal and KMS Sign are not measured");
      // The parts a seal runs one after another, with the signature at its budget, stand in for
      // it; added up they overstate it, since the seal overlaps the envelope with the writes.
      const unsigned = (q) => report.r2WriteRound[q] + report.database[q] + report.envelope[q];
      slotSealMs.add(unsigned("p50") + KMS_SIGN_P95_MS);
      slotSealP95Ms.add(unsigned("p95") + KMS_SIGN_P95_MS);
    }
    holdMs.add(report.hold.p95);
  }
  console.log(
    `seal status=${res.status} ${JSON.stringify(report ?? null)} x-vercel-id=${res.headers["X-Vercel-Id"]}`,
  );
  check(res, {
    measured: () => report !== undefined,
    "ran in iad1": (r) => functionRegion(r) === "iad1",
  });
}
