export type DbEvent = {
  name: "db_rls_violation" | "db_pool_exhausted" | "db_compute_unavailable";
  pool: "app" | "system";
  pgCode?: string;
  reason?: string;
};

type DbEventSink = (event: DbEvent) => void;

const POOL_EXHAUSTED_WINDOW_MS = 10 * 60 * 1000;
const POOL_EXHAUSTED_THRESHOLD = 5;

let sink: DbEventSink | null = null;
let poolExhaustedAt: number[] = [];

// The ops channel lives in a package that depends on this one, so it plugs in here at startup.
export function setDbEventSink(next: DbEventSink | null): void {
  sink = next;
  poolExhaustedAt = [];
}

export function emitDbEvent(event: DbEvent): void {
  if (event.name === "db_pool_exhausted") {
    // Counted per instance in memory: writing the count to the database would add load right when it is saturated.
    const now = Date.now();
    poolExhaustedAt = poolExhaustedAt.filter((at) => now - at < POOL_EXHAUSTED_WINDOW_MS);
    poolExhaustedAt.push(now);
    if (poolExhaustedAt.length <= POOL_EXHAUSTED_THRESHOLD) return;
  }
  try {
    sink?.(event);
  } catch (error) {
    // Reporting must never turn a handled database error into a crash.
    console.error("db event sink failed", error);
  }
}
