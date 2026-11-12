import { attachDatabasePool } from "@vercel/functions";
import pg from "pg";
import { readDbEnv } from "./env.ts";

export type PoolName = "app" | "system";

const DEFAULT_MAX: Record<PoolName, number> = { app: 5, system: 3 };

const pools = new Map<PoolName, pg.Pool>();

// One pool per role and per instance, created on first use so importing the package never needs credentials.
export function getPool(name: PoolName): pg.Pool {
  const existing = pools.get(name);
  if (existing !== undefined) return existing;
  const env = readDbEnv();
  const pool = new pg.Pool({
    connectionString: name === "app" ? env.DATABASE_URL : env.DATABASE_URL_SYSTEM,
    max: env.DB_POOL_MAX ?? DEFAULT_MAX[name],
    idleTimeoutMillis: 5000,
    // Bounded so a saturated pool answers 503 with Retry-After instead of hanging the request.
    connectionTimeoutMillis: 2000,
  });
  // An idle client dropped by the server must not take the process down; the pool discards it.
  pool.on("error", (error) => console.error(`idle ${name} database client failed`, error));
  // Lets Vercel Fluid close idle clients before the function instance suspends.
  if (process.env.VERCEL) attachDatabasePool(pool);
  pools.set(name, pool);
  return pool;
}

export async function closeDbPools(): Promise<void> {
  const open = [...pools.values()];
  pools.clear();
  await Promise.all(open.map((pool) => pool.end()));
}
