export type DbEvent = {
  name: "db_rls_violation" | "db_pool_exhausted" | "db_compute_unavailable";
  pool: "app" | "system";
  pgCode?: string;
  reason?: string;
};

type DbEventSink = (event: DbEvent) => void;

// The telemetry package depends on this one, so the host app wires its alerting in through a sink.
let sink: DbEventSink | null = null;

export function setDbEventSink(next: DbEventSink | null): void {
  sink = next;
}

const POOL_WINDOW_MS = 10 * 60 * 1000;
const POOL_THRESHOLD = 5;
const poolHits: number[] = [];

// A few connect timeouts are normal bursts; only sustained exhaustion on this instance is worth an alert.
function poolAlertDue(now: number): boolean {
  while (poolHits.length > 0 && now - (poolHits[0] as number) >= POOL_WINDOW_MS) poolHits.shift();
  poolHits.push(now);
  // Only the newest THRESHOLD + 1 hits can decide the alert, so older ones are dead weight.
  if (poolHits.length > POOL_THRESHOLD + 1) poolHits.shift();
  return poolHits.length > POOL_THRESHOLD;
}

export function emitDbEvent(event: DbEvent): void {
  try {
    if (event.name === "db_pool_exhausted" && !poolAlertDue(Date.now())) return;
    sink?.(event);
  } catch {
    // Observability must never turn a database failure into a different one.
  }
}

export function dbPoolHitCountForTest(): number {
  return poolHits.length;
}

export function resetDbEventsForTest(): void {
  sink = null;
  poolHits.length = 0;
}
