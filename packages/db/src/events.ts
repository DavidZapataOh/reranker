export type DbPool = "app" | "system";

export type DbEvent = {
  name: "db_rls_violation" | "db_pool_exhausted" | "db_compute_unavailable";
  pool: DbPool;
  pgCode?: string;
  reason?: string;
};

export type DbEventSink = (event: DbEvent) => void;

// The ops channel depends on this package, so it registers itself here instead of being imported.
let sink: DbEventSink | null = null;

export function setDbEventSink(next: DbEventSink | null): void {
  sink = next;
}

// One saturated burst is normal under load; only a sustained one is worth waking someone up.
// Counted per instance, so the alert never needs the database that is saturated.
const EXHAUSTION_WINDOW_MS = 10 * 60_000;
const EXHAUSTION_THRESHOLD = 5;
let exhaustedAt: number[] = [];

export function emitDbEvent(event: DbEvent): void {
  if (event.name === "db_pool_exhausted") {
    const now = Date.now();
    exhaustedAt = exhaustedAt.filter((at) => now - at < EXHAUSTION_WINDOW_MS);
    exhaustedAt.push(now);
    if (exhaustedAt.length <= EXHAUSTION_THRESHOLD) return;
  }
  try {
    sink?.(event);
  } catch {
    // Reporting must never turn a handled database error into a crash.
  }
}
