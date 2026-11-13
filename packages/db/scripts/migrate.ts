import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { dbEnv } from "../src/env";

export type RunMigrationsOptions = {
  url: string;
  migrationsFolder: string;
  concurrentFolder: string;
  retries?: number;
  lockTimeout?: string;
  statementTimeout?: string;
  lockWaitTimeout?: string;
};

export type MigrationResult = { applied: number; concurrent: string[] };

const LOCK_NOT_AVAILABLE = "55P03";
const MIGRATIONS_SCHEMA = "drizzle";
const MIGRATIONS_TABLE = "__drizzle_migrations";

// Only the idempotent form is accepted so a deploy interrupted mid-build can always be rerun.
const CONCURRENT_INDEX =
  /^create\s+(?:unique\s+)?index\s+concurrently\s+if\s+not\s+exists\s+("?[a-z_][a-z0-9_]*"?)\s+on\s+(?:only\s+)?((?:"?[a-z_][a-z0-9_]*"?\.)?"?[a-z_][a-z0-9_]*"?)[\s(]/i;

const MIGRATION_LOCK = "hashtext('reranker.migrate')";

// Unquoted identifiers fold to lower case in Postgres; quoted ones are kept as written.
const identifier = (raw: string) => (raw.startsWith('"') ? raw.slice(1, -1) : raw.toLowerCase());

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function databaseError(error: unknown): pg.DatabaseError | undefined {
  for (let current = error; current instanceof Error; current = current.cause) {
    if (current instanceof pg.DatabaseError) return current;
  }
  return undefined;
}

// A held ACCESS EXCLUSIVE lock is usually a short-lived query; failing fast under lock_timeout
// and retrying keeps the migration from queueing every later query on that table behind it.
async function withLockRetries<T>(retries: number, run: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await run();
    } catch (error) {
      const cause = databaseError(error);
      if (cause?.code !== LOCK_NOT_AVAILABLE) throw error;
      if (attempt >= retries) {
        throw new Error(`Migration failed after ${attempt} attempts: ${cause.message}`, {
          cause: error,
        });
      }
      await sleep(1000 * 2 ** (attempt - 1));
    }
  }
}

async function countApplied(client: pg.Client): Promise<number> {
  const table = `${MIGRATIONS_SCHEMA}.${MIGRATIONS_TABLE}`;
  const { rows } = await client.query<{ exists: boolean }>(
    "select to_regclass($1) is not null as exists",
    [table],
  );
  if (!rows[0]?.exists) return 0;
  const count = await client.query<{ count: string }>(`select count(*) from ${table}`);
  return Number(count.rows[0]?.count);
}

function parseConcurrentIndex(file: string, sql: string): { index: string; table: string } {
  const statement = sql.replace(/--.*$/gm, "").trim().replace(/;\s*$/, "");
  const match = CONCURRENT_INDEX.exec(statement);
  if (!match?.[1] || !match[2] || statement.includes(";")) {
    throw new Error(`${file} must hold a single CREATE INDEX CONCURRENTLY IF NOT EXISTS statement`);
  }
  return { index: identifier(match[1]), table: match[2] };
}

// CREATE INDEX CONCURRENTLY cannot run inside a transaction, and an interrupted one leaves an
// invalid index that IF NOT EXISTS would silently keep, so it is dropped and rebuilt.
async function applyConcurrentIndex(
  client: pg.Client,
  file: string,
  sql: string,
): Promise<boolean> {
  const { index, table } = parseConcurrentIndex(file, sql);
  const { rows } = await client.query<{ schema: string; valid: boolean }>(
    `select n.nspname as schema, i.indisvalid as valid
     from pg_class c
     join pg_index i on i.indexrelid = c.oid
     join pg_namespace n on n.oid = c.relnamespace
     where c.relname = $1
       and c.relnamespace = (select relnamespace from pg_class where oid = to_regclass($2))`,
    [index, table],
  );
  const existing = rows[0];
  if (existing?.valid) return false;
  if (existing) {
    await client.query(
      `drop index concurrently if exists ${client.escapeIdentifier(existing.schema)}.${client.escapeIdentifier(index)}`,
    );
  }
  await client.query(sql);
  return true;
}

async function assertIndexesValid(client: pg.Client): Promise<void> {
  const { rows } = await client.query<{ name: string }>(
    `select n.nspname || '.' || c.relname as name
     from pg_index i
     join pg_class c on c.oid = i.indexrelid
     join pg_namespace n on n.oid = c.relnamespace
     where not i.indisvalid
     order by 1`,
  );
  if (rows.length > 0) {
    throw new Error(`Invalid indexes remain: ${rows.map((row) => row.name).join(", ")}`);
  }
}

export async function runMigrations({
  url,
  migrationsFolder,
  concurrentFolder,
  retries = 3,
  lockTimeout = "3s",
  statementTimeout = "60s",
  lockWaitTimeout = "5min",
}: RunMigrationsOptions): Promise<MigrationResult> {
  // Generous connect timeout: the first connection may have to wake a suspended Neon compute.
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 15_000 });
  await client.connect();
  let locked = false;
  try {
    // A build killed mid-run must not keep its backend, and the lock, alive.
    await client.query("select set_config('client_connection_check_interval', '10s', false)");
    // Drizzle's migrator takes no lock, so two deploys migrating the same branch would race.
    // A session lock is safe here because this is the direct connection, never the pooler;
    // the wait is bounded so a stuck holder fails the deploy instead of hanging it.
    await client.query("select set_config('lock_timeout', $1, false)", [lockWaitTimeout]);
    try {
      await client.query(`select pg_advisory_lock(${MIGRATION_LOCK})`);
    } catch (error) {
      if (databaseError(error)?.code !== LOCK_NOT_AVAILABLE) throw error;
      throw new Error(
        `Another migration held the migration lock for more than ${lockWaitTimeout}`,
        { cause: error },
      );
    }
    locked = true;
    await client.query("select set_config('lock_timeout', $1, false)", [lockTimeout]);
    await client.query("select set_config('statement_timeout', $1, false)", [statementTimeout]);

    const before = await countApplied(client);
    const db = drizzle({ client });
    await withLockRetries(retries, () =>
      migrate(db, {
        migrationsFolder,
        migrationsSchema: MIGRATIONS_SCHEMA,
        migrationsTable: MIGRATIONS_TABLE,
      }),
    );
    const applied = (await countApplied(client)) - before;

    const files = (await readdir(concurrentFolder)).filter((file) => file.endsWith(".sql")).sort();
    const concurrent: string[] = [];
    // Index builds scale with table size, so only lock_timeout bounds them; a statement
    // timeout would fail every deploy once a table outgrows it.
    await client.query("select set_config('statement_timeout', '0', false)");
    for (const file of files) {
      const sql = await readFile(join(concurrentFolder, file), "utf8");
      if (await withLockRetries(retries, () => applyConcurrentIndex(client, file, sql))) {
        concurrent.push(file);
      }
    }
    await client.query("select set_config('statement_timeout', $1, false)", [statementTimeout]);
    await assertIndexesValid(client);
    return { applied, concurrent };
  } finally {
    // Ending the session releases the lock as well, so a failed unlock must not mask the
    // migration error that brought us here.
    if (locked) {
      await client.query(`select pg_advisory_unlock(${MIGRATION_LOCK})`).catch(() => undefined);
    }
    await client.end();
  }
}

async function main(): Promise<void> {
  const env = dbEnv.pick({ DATABASE_URL_MIGRATIONS: true }).required().safeParse(process.env);
  if (!env.success) {
    const detail = env.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid database environment: ${detail}`);
  }
  const migrationsFolder = fileURLToPath(new URL("../migrations", import.meta.url));
  const started = performance.now();
  const result = await runMigrations({
    url: env.data.DATABASE_URL_MIGRATIONS,
    migrationsFolder,
    concurrentFolder: join(migrationsFolder, "concurrent"),
  });
  console.log(JSON.stringify({ ...result, ms: Math.round(performance.now() - started) }));
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
