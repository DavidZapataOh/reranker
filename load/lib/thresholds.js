/**
 * Latency and error budget for a scenario. Any breach makes `k6 run` exit non-zero.
 * `-e P95_MS=<ms>` overrides `p95Ms` for every scenario, so a dispatch can prove the gate bites.
 * @param {{ p95Ms: number, errorRate?: number }} budget
 */
export function latency({ p95Ms, errorRate = 0.01 }) {
  const raw = __ENV.P95_MS || p95Ms;
  const p95 = Number(raw);
  if (!(Number.isFinite(p95) && p95 > 0)) {
    throw new Error(`p95 budget must be a positive number of ms, got ${JSON.stringify(raw)}`);
  }
  return {
    http_req_duration: [`p(95)<${p95}`],
    http_req_failed: [`rate<${errorRate}`],
  };
}
