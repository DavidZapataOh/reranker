import { attachDatabasePool } from "@vercel/functions";
import pg from "pg";
import { readDbEnv } from "./env.ts";
import type { DbPool } from "./events.ts";

// Per Fluid instance. Neon's pooler queues up to 10,000 clients, so small pools that fail fast
// (connectionTimeoutMillis) turn overload into a 503 with Retry-After instead of a hang.
const DEFAULT_MAX: Record<DbPool, number> = { app: 5, system: 3 };

const pools = new Map<DbPool, pg.Pool>();

/** Internal: callers go through withTenant, withTenants or withSystem. */
export function pool(kind: DbPool): pg.Pool {
  const existing = pools.get(kind);
  if (existing !== undefined) return existing;

  const env = readDbEnv();
  const created = new pg.Pool({
    connectionString: kind === "app" ? env.DATABASE_URL : env.DATABASE_URL_SYSTEM,
    max: env.DB_POOL_MAX ?? DEFAULT_MAX[kind],
    idleTimeoutMillis: 5000,
    connectionTimeoutMillis: 2000,
  });
  // An idle client dropped by the server (compute suspended, pooler restart) must not crash the process.
  created.on("error", (error) => {
    console.error(`database pool "${kind}": idle client error: ${error.message}`);
  });
  // Lets Fluid compute release idle clients before the instance is suspended.
  if (process.env.VERCEL) attachDatabasePool(created);

  pools.set(kind, created);
  return created;
}

/** Ends both pools; for scripts and tests that must exit cleanly. */
export async function closeDatabases(): Promise<void> {
  const entries = [...pools.values()];
  pools.clear();
  await Promise.all(entries.map((entry) => entry.end()));
}
