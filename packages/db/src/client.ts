import { attachDatabasePool } from "@vercel/functions";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import { readDbEnv } from "./env.ts";
import type { DbPool } from "./events.ts";
import * as schema from "./schema/index.ts";

export type Schema = typeof schema;
export type Database = NodePgDatabase<Schema> & { $client: pg.Pool };

// Per Fluid instance. Neon's pooler queues up to 10,000 clients, so small pools that fail fast
// (connectionTimeoutMillis) turn overload into a 503 with Retry-After instead of a hang.
const DEFAULT_MAX: Record<DbPool, number> = { app: 5, system: 3 };

const databases = new Map<DbPool, { pool: pg.Pool; db: Database }>();

/** Internal: callers go through withTenant, withTenants or withSystem. */
export function database(kind: DbPool): Database {
  const existing = databases.get(kind);
  if (existing !== undefined) return existing.db;

  const env = readDbEnv();
  const pool = new pg.Pool({
    connectionString: kind === "app" ? env.DATABASE_URL : env.DATABASE_URL_SYSTEM,
    max: env.DB_POOL_MAX ?? DEFAULT_MAX[kind],
    idleTimeoutMillis: 5000,
    connectionTimeoutMillis: 2000,
  });
  // An idle client dropped by the server (compute suspended, pooler restart) must not crash the process.
  pool.on("error", (error) => {
    console.error(`database pool "${kind}": idle client error: ${error.message}`);
  });
  // Lets Fluid compute release idle clients before the instance is suspended.
  if (process.env.VERCEL) attachDatabasePool(pool);

  const db = drizzle({ client: pool, schema, casing: "snake_case" });
  databases.set(kind, { pool, db });
  return db;
}

/** Ends both pools; for scripts and tests that must exit cleanly. */
export async function closeDatabases(): Promise<void> {
  const entries = [...databases.values()];
  databases.clear();
  await Promise.all(entries.map(({ pool }) => pool.end()));
}
