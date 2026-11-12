import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { pgErrorCode } from "../src/errors.ts";

export type MigrationOptions = {
  url: string;
  migrationsFolder: string;
  concurrentFolder: string;
  migrationsSchema?: string;
  retries?: number;
  lockTimeout?: string;
  statementTimeout?: string;
};

export type MigrationResult = { applied: number; concurrent: string[] };

// Serializes concurrent deploys against the same branch; a session lock is fine on the direct connection.
const LOCK_KEY = "reranker.migrate";
const LOCK_NOT_AVAILABLE = "55P03";
const OUR_SCHEMAS = ["app", "auth", "public_panel", "ops"];
const BREAKPOINT = "--> statement-breakpoint";
const CONCURRENT_INDEX =
  /create\s+(?:unique\s+)?index\s+concurrently\s+if\s+not\s+exists\s+"?([a-z_][a-z0-9_]*)"?/i;

export async function runMigrations(opts: MigrationOptions): Promise<MigrationResult> {
  const {
    url,
    migrationsFolder,
    concurrentFolder,
    migrationsSchema = "drizzle",
    retries = 3,
    lockTimeout = "3s",
    statementTimeout = "60s",
  } = opts;
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query("select pg_advisory_lock(hashtext($1))", [LOCK_KEY]);
    try {
      await client.query("select set_config('lock_timeout', $1, false)", [lockTimeout]);
      await client.query("select set_config('statement_timeout', $1, false)", [statementTimeout]);
      const before = await countApplied(client, migrationsSchema);
      await withLockRetries(retries, () =>
        migrate(drizzle({ client }), { migrationsFolder, migrationsSchema }),
      );
      const applied = (await countApplied(client, migrationsSchema)) - before;
      const concurrent = await runConcurrent(client, concurrentFolder, retries);
      await assertNoInvalidIndexes(client);
      return { applied, concurrent };
    } finally {
      await client.query("select pg_advisory_unlock(hashtext($1))", [LOCK_KEY]);
    }
  } finally {
    await client.end();
  }
}

async function countApplied(client: pg.Client, schema: string): Promise<number> {
  const table = await client.query<{ exists: boolean }>(
    "select to_regclass(format('%I.__drizzle_migrations', $1::text)) is not null as exists",
    [schema],
  );
  if (!table.rows[0]?.exists) return 0;
  const result = await client.query<{ count: string }>(
    `select count(*) from ${client.escapeIdentifier(schema)}.__drizzle_migrations`,
  );
  return Number(result.rows[0]?.count ?? 0);
}

// Waiting behind a long transaction would block every query queued after the migration's lock request,
// so a short lock_timeout gives up fast and retries with backoff.
async function withLockRetries(retries: number, step: () => Promise<unknown>): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await step();
      return;
    } catch (error) {
      if (pgErrorCode(error) !== LOCK_NOT_AVAILABLE || attempt >= retries) throw error;
      await sleep(1000 * 2 ** (attempt - 1));
    }
  }
}

// CREATE INDEX CONCURRENTLY cannot run inside the migration transaction, and a run interrupted midway
// leaves an invalid index that IF NOT EXISTS would skip, so it is dropped and rebuilt.
async function runConcurrent(
  client: pg.Client,
  folder: string,
  retries: number,
): Promise<string[]> {
  const files = (await readdir(folder).catch(() => [] as string[]))
    .filter((file) => file.endsWith(".sql"))
    .sort();
  if (files.length === 0) return files;
  // Index builds on large tables legitimately outlast the migration statement timeout; lock_timeout stays.
  await client.query("select set_config('statement_timeout', '0', false)");
  for (const file of files) {
    const statements = (await readFile(join(folder, file), "utf8"))
      .split(BREAKPOINT)
      .map((statement) => statement.trim())
      .filter((statement) => statement.replace(/--.*$/gm, "").trim() !== "");
    for (const statement of statements) {
      const index = CONCURRENT_INDEX.exec(statement)?.[1];
      if (index !== undefined) await dropInvalidIndex(client, index);
      await withLockRetries(retries, () => client.query(statement));
    }
  }
  return files;
}

async function dropInvalidIndex(client: pg.Client, name: string): Promise<void> {
  const invalid = await client.query<{ schema: string }>(
    `select n.nspname as schema from pg_index i
       join pg_class c on c.oid = i.indexrelid
       join pg_namespace n on n.oid = c.relnamespace
     where c.relname = $1 and not i.indisvalid`,
    [name],
  );
  for (const { schema } of invalid.rows) {
    await client.query(
      `drop index concurrently if exists ${client.escapeIdentifier(schema)}.${client.escapeIdentifier(name)}`,
    );
  }
}

async function assertNoInvalidIndexes(client: pg.Client): Promise<void> {
  const invalid = await client.query<{ name: string }>(
    `select n.nspname || '.' || c.relname as name from pg_index i
       join pg_class c on c.oid = i.indexrelid
       join pg_namespace n on n.oid = c.relnamespace
     where not i.indisvalid and n.nspname = any($1::text[])`,
    [OUR_SCHEMAS],
  );
  if (invalid.rows.length > 0) {
    throw new Error(
      `Invalid indexes after migration: ${invalid.rows.map((r) => r.name).join(", ")}`,
    );
  }
}

if (import.meta.main) {
  const url = process.env.DATABASE_URL_MIGRATIONS;
  if (url === undefined || url === "") {
    console.error("DATABASE_URL_MIGRATIONS is required");
    process.exit(1);
  }
  const started = performance.now();
  try {
    const result = await runMigrations({
      url,
      migrationsFolder: fileURLToPath(new URL("../migrations", import.meta.url)),
      concurrentFolder: fileURLToPath(new URL("../migrations/concurrent", import.meta.url)),
    });
    console.log(JSON.stringify({ ...result, ms: Math.round(performance.now() - started) }));
  } catch (error) {
    // Drizzle wraps the driver error; its message alone would hide the Postgres reason.
    const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : "";
    console.error("Migration failed:", error instanceof Error ? error.message : error, cause);
    process.exit(1);
  }
}
