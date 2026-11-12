import { check, sleep } from "k6";
import http from "k6/http";
import { only } from "../lib/scenarios.js";
import { baseUrl, params } from "../lib/target.js";
import { latency } from "../lib/thresholds.js";

// The landing is static and served from Vercel's CDN: at 10× it must keep answering 200
// within the same budget, with no queueing or degradation to declare.
export const options = {
  scenarios: only({
    nominal: { executor: "constant-vus", vus: 50, duration: "1m" },
    stress: { executor: "constant-vus", vus: 500, duration: "1m" },
  }),
  thresholds: {
    ...latency({ p95Ms: Number(__ENV.P95_MS || 800) }),
    checks: ["rate>0.99"],
  },
};

const url = `${baseUrl()}/`;

export default function () {
  const res = http.get(url, params());
  check(res, { "status 200": (r) => r.status === 200 });
  // A visitor's think time; without it 50 VUs become a request flood, not 50 visitors.
  sleep(1);
}
