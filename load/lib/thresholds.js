/**
 * Latency and error budget for a scenario, from the budget its owning plan declares.
 * @param {{ p95Ms: number, errorRate?: number }} budget
 */
export function latency({ p95Ms, errorRate = 0.01 }) {
  // An empty or mistyped budget would otherwise become `p(95)<NaN` or `p(95)<0`.
  if (!Number.isFinite(p95Ms) || p95Ms <= 0) {
    throw new Error(`p95Ms must be a positive number, got ${JSON.stringify(p95Ms)}`);
  }
  if (!Number.isFinite(errorRate) || errorRate < 0 || errorRate > 1) {
    throw new Error(`errorRate must be between 0 and 1, got ${JSON.stringify(errorRate)}`);
  }
  return {
    http_req_duration: [`p(95)<${p95Ms}`],
    http_req_failed: [`rate<${errorRate}`],
  };
}
