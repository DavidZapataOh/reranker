import { attachDatabasePool } from "@vercel/functions";
import pg from "pg";
import { readDbEnv } from "./env";

type PoolName = "app" | "system";

const DEFAULT_MAX: Record<PoolName, number> = { app: 5, system: 3 };

// pg treats `require` as `verify-full` only until libpq semantics become the default, and warns
// on every process meanwhile; pinning verify-full keeps the certificate check either way.
export function verifiedTlsUrl(value: string): string {
  const url = new URL(value);
  if (!url.hostname.endsWith(".neon.tech")) return value;
  url.searchParams.delete("uselibpqcompat");
  url.searchParams.set("sslmode", "verify-full");
  return url.toString();
}

function createPool(name: PoolName): pg.Pool {
  const env = readDbEnv();
  const pool = new pg.Pool({
    connectionString: verifiedTlsUrl(name === "app" ? env.DATABASE_URL : env.DATABASE_URL_SYSTEM),
    max: env.DB_POOL_MAX ?? DEFAULT_MAX[name],
    idleTimeoutMillis: 5000,
    connectionTimeoutMillis: 2000,
  });
  // An idle client dropped by the pooler or a suspended compute must not crash the process;
  // the pool discards it and the next checkout opens a fresh connection.
  pool.on("error", (error) => {
    console.error(`[db] idle ${name} client error`, { code: (error as { code?: unknown }).code });
  });
  // Lets Fluid compute close idle clients before the instance is suspended.
  if (process.env.VERCEL) attachDatabasePool(pool);
  return pool;
}

const pools = new Map<PoolName, pg.Pool>();

// Created on first use so importing the package never needs the database environment.
function pool(name: PoolName): pg.Pool {
  let existing = pools.get(name);
  if (!existing) {
    existing = createPool(name);
    pools.set(name, existing);
  }
  return existing;
}

export const appPool = (): pg.Pool => pool("app");
export const systemPool = (): pg.Pool => pool("system");

export async function endPools(): Promise<void> {
  const open = [...pools.values()];
  pools.clear();
  await Promise.all(open.map((p) => p.end()));
}
