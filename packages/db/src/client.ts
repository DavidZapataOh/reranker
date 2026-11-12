import { attachDatabasePool } from "@vercel/functions";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import { readDbEnv } from "./env.ts";
import type { DbPoolKind } from "./events.ts";

// Per Fluid instance. PgBouncer queues the rest, so small pools keep Postgres connections free.
const DEFAULT_MAX: Record<DbPoolKind, number> = { app: 5, system: 3 };

type Handle = { pool: pg.Pool; db: NodePgDatabase };

const handles = new Map<DbPoolKind, Handle>();

// Lazy so importing the package (e.g. during `next build`) never needs the variables.
export function getDb(kind: DbPoolKind): NodePgDatabase {
  let handle = handles.get(kind);
  if (!handle) {
    handle = createHandle(kind);
    handles.set(kind, handle);
  }
  return handle.db;
}

function createHandle(kind: DbPoolKind): Handle {
  const env = readDbEnv();
  const pool = new pg.Pool({
    connectionString: kind === "app" ? env.DATABASE_URL : env.DATABASE_URL_SYSTEM,
    max: env.DB_POOL_MAX ?? DEFAULT_MAX[kind],
    idleTimeoutMillis: 5000,
    // A queued request fails fast with service_unavailable instead of holding the function.
    connectionTimeoutMillis: 2000,
  });
  // An idle client dropped by the server (compute suspended, pooler restart) must not crash the process.
  pool.on("error", (error) => {
    console.error(`[db] idle ${kind} connection error: ${error.message}`);
  });
  if (process.env.VERCEL) attachDatabasePool(pool);
  return { pool, db: drizzle({ client: pool, casing: "snake_case" }) };
}

export async function closeDb(): Promise<void> {
  const open = [...handles.values()];
  handles.clear();
  await Promise.all(open.map(({ pool }) => pool.end()));
}
