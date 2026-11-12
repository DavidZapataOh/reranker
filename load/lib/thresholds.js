/**
 * Latency and error budget for a scenario. Any breach makes `k6 run` exit non-zero.
 * @param {{ p95Ms: number, errorRate?: number }} budget
 */
export function latency({ p95Ms, errorRate = 0.01 }) {
  return {
    http_req_duration: [`p(95)<${p95Ms}`],
    http_req_failed: [`rate<${errorRate}`],
  };
}
