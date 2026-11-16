import type { DbEvent } from "@reranker/db";
import { type OpsAlertKind, sendOpsAlert } from "@reranker/telemetry";

const KINDS = {
  db_rls_violation: "db-rls-violation",
  db_pool_exhausted: "db-pool-exhausted",
  db_compute_unavailable: "neon-quota",
} as const satisfies Record<DbEvent["name"], OpsAlertKind>;

// The database package cannot import telemetry (the dependency runs the other way), so the app
// maps its events to alerts here.
export function routeDbEvent(event: DbEvent): void {
  void sendOpsAlert(KINDS[event.name], {
    pool: event.pool,
    ...(event.pgCode && { pgCode: event.pgCode }),
    ...(event.reason && { reason: event.reason }),
  });
}
