import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

export type MigrationOptions = {
  /** Direct (non-pooled) owner connection: session advisory locks do not survive PgBouncer. */
  url: string;
  migrationsFolder: string;
  concurrentFolder: string;
  retries?: number;
  lockTimeout?: string;
  statementTimeout?: string;
};

export type MigrationResult = { applied: number; concurrent: string[] };

const SCHEMAS = ["app", "auth", "public_panel", "ops"];
const LOCK_NOT_AVAILABLE = "55P03";
const BREAKPOINT = "--> statement-breakpoint";

export async function runMigrations(options: MigrationOptions): Promise<MigrationResult> {
  const { retries = 3, lockTimeout = "3s", statementTimeout = "60s" } = options;
  const client = new pg.Client({
    connectionString: options.url,
    application_name: "reranker-migrate",
    // Covers a compute waking up from scale to zero.
    connectionTimeoutMillis: 30_000,
  });
  await client.connect();
  try {
    // Two deploys migrating the same branch queue here; the second finds nothing pending.
    await client.query("select pg_advisory_lock(hashtext('reranker.migrate'))");
    await client.query(
      "select set_config('lock_timeout', $1, false), set_config('statement_timeout', $2, false)",
      [lockTimeout, statementTimeout],
    );

    const before = await countApplied(client);
    await withLockRetries(retries, () =>
      migrate(drizzle({ client }), {
        migrationsFolder: options.migrationsFolder,
        migrationsSchema: "drizzle",
      }),
    );
    const applied = (await countApplied(client)) - before;
    await assertJournalApplied(client, options.migrationsFolder);

    // Index builds on populated tables can outlast any fixed limit and CONCURRENTLY never blocks writes.
    await client.query("select set_config('statement_timeout', '0', false)");
    const concurrent = await runConcurrent(client, options.concurrentFolder, retries);
    await assertIndexesValid(client);
    return { applied, concurrent };
  } finally {
    // Ending the session also releases the advisory lock if the unlock never ran.
    await client.query("select pg_advisory_unlock_all()").catch(() => undefined);
    await client.end();
  }
}

async function countApplied(client: pg.Client): Promise<number> {
  const { rows } = await client.query<{ exists: boolean }>(
    "select to_regclass('drizzle.__drizzle_migrations') is not null as exists",
  );
  if (!rows[0]?.exists) return 0;
  const result = await client.query<{ count: number }>(
    "select count(*)::int as count from drizzle.__drizzle_migrations",
  );
  return result.rows[0]?.count ?? 0;
}

// drizzle only applies files newer than the last recorded one and never compares contents, so a
// file edited after it ran, or merged with an older timestamp, would be skipped without notice.
async function assertJournalApplied(client: pg.Client, migrationsFolder: string): Promise<void> {
  const journal = JSON.parse(
    await readFile(join(migrationsFolder, "meta", "_journal.json"), "utf8"),
  ) as { entries: { tag: string }[] };
  const files = readMigrationFiles({ migrationsFolder });
  const { rows } = await client.query<{ hash: string }>(
    "select hash from drizzle.__drizzle_migrations",
  );
  const recorded = new Set(rows.map((row) => row.hash));
  const missing = journal.entries
    .filter((_, index) => !recorded.has(files[index]?.hash ?? ""))
    .map((entry) => entry.tag);
  if (missing.length > 0) {
    throw new Error(
      `Migrations in the journal that this database never ran as written: ${missing.join(", ")}`,
    );
  }
}

async function withLockRetries<T>(retries: number, run: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await run();
    } catch (error) {
      if (pgCode(error) !== LOCK_NOT_AVAILABLE) throw error;
      if (attempt >= retries) {
        throw new Error(
          `Migration stopped: lock timeout on every one of ${retries} attempts; nothing was applied by the failed attempt`,
          { cause: error },
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** (attempt - 1)));
    }
  }
}

function pgCode(error: unknown): string | undefined {
  for (let current = error; current instanceof Error; current = current.cause) {
    if ("code" in current && typeof current.code === "string") return current.code;
  }
  return undefined;
}

async function runConcurrent(client: pg.Client, folder: string, retries: number) {
  const files = (await readdir(folder).catch(() => [] as string[]))
    .filter((file) => file.endsWith(".sql"))
    .sort();
  if (files.length === 0) return [];

  for (const file of files) {
    const statements = (await readFile(join(folder, file), "utf8"))
      .split(BREAKPOINT)
      .map((statement) => statement.trim())
      .filter((statement) => statement.length > 0);
    // Each statement runs on its own: CONCURRENTLY is refused inside a transaction block.
    for (const statement of statements) {
      await withLockRetries(retries, async () => {
        // A build that timed out waiting for older transactions has already committed an invalid
        // index, which IF NOT EXISTS would then keep; every attempt starts by dropping those.
        await dropInvalidIndexes(client);
        await client.query(statement);
      });
    }
  }
  return files;
}

// The advisory lock guarantees no other runner is building an index right now, so every invalid
// index in the product schemas is a leftover of an interrupted build.
async function dropInvalidIndexes(client: pg.Client): Promise<void> {
  const { rows } = await client.query<{ statement: string }>(
    `select format('drop index concurrently if exists %I.%I', n.nspname, c.relname) as statement
     from pg_index i join pg_class c on c.oid = i.indexrelid join pg_namespace n on n.oid = c.relnamespace
     where not i.indisvalid and n.nspname = any($1)`,
    [SCHEMAS],
  );
  for (const { statement } of rows) {
    await client.query(statement);
  }
}

async function assertIndexesValid(client: pg.Client): Promise<void> {
  const { rows } = await client.query<{ name: string }>(
    `select n.nspname || '.' || c.relname as name
     from pg_index i join pg_class c on c.oid = i.indexrelid join pg_namespace n on n.oid = c.relnamespace
     where not i.indisvalid and n.nspname = any($1)`,
    [SCHEMAS],
  );
  if (rows.length > 0) {
    throw new Error(`Invalid indexes after migrating: ${rows.map((row) => row.name).join(", ")}`);
  }
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL_MIGRATIONS;
  if (url === undefined || url === "") {
    throw new Error("DATABASE_URL_MIGRATIONS is required to migrate");
  }
  const migrationsFolder = fileURLToPath(new URL("../migrations", import.meta.url));
  const started = performance.now();
  const result = await runMigrations({
    url,
    migrationsFolder,
    concurrentFolder: join(migrationsFolder, "concurrent"),
  });
  console.log(JSON.stringify({ ...result, ms: Math.round(performance.now() - started) }));
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    // Only messages: a connection error object can carry the connection string.
    const causes: string[] = [];
    for (let current = error; current instanceof Error; current = current.cause) {
      causes.push(current.message);
    }
    console.error(`db:migrate failed: ${causes.join(" <- ")}`);
    process.exit(1);
  });
}
