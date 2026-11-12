export type DbPoolKind = "app" | "system";

export type DbEvent = {
  name: "db_rls_violation" | "db_pool_exhausted" | "db_compute_unavailable";
  pool: DbPoolKind;
  pgCode?: string;
  reason?: string;
};

type Sink = (event: DbEvent) => void;

// One saturated burst is normal under load; only a sustained one deserves an alert. Counted per
// instance in memory so reporting never needs the database that is saturated.
const POOL_EXHAUSTED_THRESHOLD = 5;
const POOL_EXHAUSTED_WINDOW_MS = 10 * 60 * 1000;

let sink: Sink | null = null;
let poolExhaustedAt: number[] = [];

// The ops channel depends on this package, so it registers itself here instead of being imported.
export function setDbEventSink(next: Sink | null): void {
  sink = next;
  poolExhaustedAt = [];
}

export function emitDbEvent(event: DbEvent): void {
  if (event.name === "db_pool_exhausted" && !poolExhaustionIsSustained()) return;
  try {
    sink?.(event);
  } catch {
    // Reporting must never turn a handled database error into a crash.
  }
}

function poolExhaustionIsSustained(): boolean {
  const now = Date.now();
  poolExhaustedAt = poolExhaustedAt.filter((at) => now - at < POOL_EXHAUSTED_WINDOW_MS);
  poolExhaustedAt.push(now);
  return poolExhaustedAt.length > POOL_EXHAUSTED_THRESHOLD;
}
