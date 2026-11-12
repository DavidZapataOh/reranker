import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { pgCodeOf } from "../src/errors.ts";

export type MigrationOptions = {
  url: string;
  migrationsFolder: string;
  concurrentFolder: string;
  retries?: number;
  lockTimeout?: string;
  statementTimeout?: string;
};

export type MigrationResult = { applied: number; concurrent: string[] };

const MIGRATIONS_SCHEMA = "drizzle";
const MIGRATIONS_TABLE = "__drizzle_migrations";
const SCHEMAS = ["app", "auth", "public_panel", "ops"];
const LOCK_NOT_AVAILABLE = "55P03";
const BREAKPOINT = "--> statement-breakpoint";
const CONCURRENT_INDEX =
  /create\s+(?:unique\s+)?index\s+concurrently\s+if\s+not\s+exists\s+"?([a-z_][a-z0-9_]*)"?/gi;

// Runs on the direct (non-pooled) owner connection, where session advisory locks are legal: two
// deploys migrating the same branch are serialized and the second one finds nothing to apply.
export async function runMigrations(opts: MigrationOptions): Promise<MigrationResult> {
  const client = new pg.Client({ connectionString: opts.url });
  await client.connect();
  try {
    await client.query("select pg_advisory_lock(hashtext('reranker.migrate'))");
    // A migration waiting behind a long query would block every query queued behind it; failing
    // fast and retrying keeps production serving.
    await client.query(
      "select set_config('lock_timeout', $1, false), set_config('statement_timeout', $2, false)",
      [opts.lockTimeout ?? "3s", opts.statementTimeout ?? "60s"],
    );
    const before = await appliedCount(client);
    await migrateWithRetries(client, opts);
    const applied = (await appliedCount(client)) - before;
    const concurrent = await runConcurrentIndexes(client, opts.concurrentFolder);
    await assertIndexesValid(client);
    return { applied, concurrent };
  } finally {
    await client.end();
  }
}

async function migrateWithRetries(client: pg.Client, opts: MigrationOptions): Promise<void> {
  const retries = opts.retries ?? 3;
  for (let attempt = 1; ; attempt++) {
    try {
      // drizzle applies every pending migration in one transaction, so a failed attempt leaves nothing behind.
      await migrate(drizzle({ client }), {
        migrationsFolder: opts.migrationsFolder,
        migrationsSchema: MIGRATIONS_SCHEMA,
        migrationsTable: MIGRATIONS_TABLE,
      });
      return;
    } catch (error) {
      if (pgCodeOf(error) !== LOCK_NOT_AVAILABLE || attempt >= retries) throw error;
      await sleep(1000 * 2 ** (attempt - 1));
    }
  }
}

async function appliedCount(client: pg.Client): Promise<number> {
  // Two statements: Postgres resolves every relation at parse time, even in an untaken CASE branch.
  const exists = await client.query<{ table: string | null }>("select to_regclass($1) as table", [
    `${MIGRATIONS_SCHEMA}.${MIGRATIONS_TABLE}`,
  ]);
  if (!exists.rows[0]?.table) return 0;
  const { rows } = await client.query<{ count: number }>(
    `select count(*)::int as count from ${MIGRATIONS_SCHEMA}.${MIGRATIONS_TABLE}`,
  );
  return rows[0]?.count ?? 0;
}

// CREATE INDEX CONCURRENTLY cannot run inside a transaction, so these files run one statement at
// a time on every deploy. IF NOT EXISTS makes a finished file a no-op; an index left invalid by
// an interrupted build is dropped and rebuilt. Deleting an index means deleting its file too.
async function runConcurrentIndexes(client: pg.Client, folder: string): Promise<string[]> {
  const files = (await readdir(folder).catch(() => [])).filter((f) => f.endsWith(".sql")).sort();
  for (const file of files) {
    const source = await readFile(join(folder, file), "utf8");
    for (const [, name] of source.matchAll(CONCURRENT_INDEX)) {
      if (name) await dropInvalidIndex(client, name);
    }
    for (const statement of source.split(BREAKPOINT)) {
      if (statement.trim()) await client.query(statement);
    }
  }
  return files;
}

async function dropInvalidIndex(client: pg.Client, name: string): Promise<void> {
  const { rows } = await client.query<{ index: string }>(
    `select c.oid::regclass::text as index
       from pg_index i
       join pg_class c on c.oid = i.indexrelid
       join pg_namespace n on n.oid = c.relnamespace
      where c.relname = $1 and n.nspname = any($2) and not i.indisvalid`,
    [name, SCHEMAS],
  );
  for (const { index } of rows) {
    // regclass text is already quoted and schema-qualified by Postgres.
    await client.query(`drop index concurrently if exists ${index}`);
  }
}

async function assertIndexesValid(client: pg.Client): Promise<void> {
  const { rows } = await client.query<{ index: string }>(
    `select c.oid::regclass::text as index
       from pg_index i
       join pg_class c on c.oid = i.indexrelid
       join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = any($1) and not i.indisvalid`,
    [SCHEMAS],
  );
  if (rows.length > 0) {
    throw new Error(`Invalid indexes after migration: ${rows.map((r) => r.index).join(", ")}`);
  }
}

if (import.meta.main) {
  const url = process.env.DATABASE_URL_MIGRATIONS;
  if (!url) {
    console.error("Missing required environment variable DATABASE_URL_MIGRATIONS");
    process.exit(1);
  }
  const started = performance.now();
  try {
    const folder = join(import.meta.dirname, "..", "migrations");
    const result = await runMigrations({
      url,
      migrationsFolder: folder,
      concurrentFolder: join(folder, "concurrent"),
    });
    console.log(JSON.stringify({ ...result, ms: Math.round(performance.now() - started) }));
  } catch (error) {
    const cause = error instanceof Error && error.cause instanceof Error ? error.cause : undefined;
    console.error(`Migration failed: ${cause?.message ?? String(error)}`);
    if (cause) console.error(String(error));
    process.exit(1);
  }
}
