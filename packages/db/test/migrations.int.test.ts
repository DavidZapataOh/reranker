import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getTestDatabaseUrl } from "@reranker/testing/neon";
import pg from "pg";
import { afterEach, beforeEach, expect, test } from "vitest";
import { runMigrations } from "../scripts/migrate";

const packageDir = fileURLToPath(new URL("..", import.meta.url));
const migrationsFolder = join(packageDir, "migrations");
const concurrentFolder = join(migrationsFolder, "concurrent");

type Journal = { entries: { idx: number; when: number; tag: string; breakpoints: boolean }[] };

const readJournal = async (folder: string): Promise<Journal> =>
  JSON.parse(await readFile(join(folder, "meta", "_journal.json"), "utf8"));

// Each test gets its own database so it starts empty and never disturbs the shared schema
// that other integration suites run against.
let databaseUrl: string;
let databaseName: string;
let workDir: string;
const clients: pg.Client[] = [];

async function connect(url = databaseUrl): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  clients.push(client);
  return client;
}

beforeEach(async () => {
  databaseName = `migrate_probe_${randomBytes(6).toString("hex")}`;
  const admin = await connect(getTestDatabaseUrl("migrations"));
  await admin.query(`create database ${databaseName}`);
  const url = new URL(getTestDatabaseUrl("migrations"));
  url.pathname = `/${databaseName}`;
  databaseUrl = url.toString();
  workDir = await mkdtemp(join(tmpdir(), "migrate-"));
});

afterEach(async () => {
  await Promise.allSettled(clients.splice(0).map((client) => client.end()));
  const admin = new pg.Client({ connectionString: getTestDatabaseUrl("migrations") });
  await admin.connect();
  try {
    await admin.query(`drop database if exists ${databaseName} with (force)`);
  } finally {
    await admin.end();
  }
  await rm(workDir, { recursive: true, force: true });
});

// A copy of the real migrations plus probe migrations, so test tables never reach migrations/.
async function withProbeMigrations(name: string, extra: string[]): Promise<string> {
  const folder = join(workDir, name);
  await cp(migrationsFolder, folder, { recursive: true });
  const journal = await readJournal(folder);
  const lastWhen = journal.entries.at(-1)?.when ?? 0;
  for (const [offset, sql] of extra.entries()) {
    const idx = journal.entries.length;
    const tag = `${String(idx).padStart(4, "0")}_probe_${offset}`;
    journal.entries.push({ idx, when: lastWhen + offset + 1, tag, breakpoints: true });
    await writeFile(join(folder, `${tag}.sql`), sql);
  }
  await writeFile(join(folder, "meta", "_journal.json"), JSON.stringify(journal));
  return folder;
}

const createProbe = `create table app.migration_probe (id integer primary key, label text not null);
--> statement-breakpoint
insert into app.migration_probe select g, md5(g::text) from generate_series(1, 1000) g;`;

const opts = () => ({ url: databaseUrl, migrationsFolder, concurrentFolder });

test("migrate on an empty database applies everything and a second run applies nothing", async () => {
  const first = await runMigrations(opts());
  expect(first.applied).toBe((await readJournal(migrationsFolder)).entries.length);
  expect(first.applied).toBeGreaterThan(0);

  const second = await runMigrations(opts());
  expect(second).toEqual({ applied: 0, concurrent: [] });

  const client = await connect();
  const { rows } = await client.query<{ nspname: string }>(
    "select nspname from pg_namespace where nspname = any($1) order by nspname",
    [["app", "auth", "ops", "public_panel"]],
  );
  expect(rows.map((row) => row.nspname)).toEqual(["app", "auth", "ops", "public_panel"]);
});

test("two concurrent runs are serialized by the advisory lock", async () => {
  const pendingCount = (await readJournal(migrationsFolder)).entries.length;
  const [a, b] = await Promise.all([runMigrations(opts()), runMigrations(opts())]);
  expect(a.applied + b.applied).toBe(pendingCount);
  expect(Math.min(a.applied, b.applied)).toBe(0);
});

test("fails without hanging when an ACCESS EXCLUSIVE lock is held", {
  timeout: 60_000,
}, async () => {
  await runMigrations({
    ...opts(),
    migrationsFolder: await withProbeMigrations("create", [createProbe]),
  });
  const alterFolder = await withProbeMigrations("alter", [
    createProbe,
    "alter table app.migration_probe add column note text;",
  ]);

  const holder = await connect();
  const holderPid = (await holder.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]
    ?.pid;
  await holder.query("begin");
  await holder.query("lock table app.migration_probe in access exclusive mode");

  const started = Date.now();
  await expect(
    runMigrations({ ...opts(), migrationsFolder: alterFolder, retries: 3 }),
  ).rejects.toThrow(/lock timeout/);
  // 3 attempts × 3 s lock_timeout + 1 s and 2 s of backoff, plus connection overhead.
  expect(Date.now() - started).toBeLessThan(3 * 3000 + 1000 + 2000 + 4000 + 1000);

  const observer = await connect();
  const { rows } = await observer.query<{ count: string }>(
    `select count(*) from pg_locks l join pg_stat_activity a using (pid)
     where a.usename = current_user and a.datname = current_database()
       and l.pid <> pg_backend_pid() and l.pid <> $1`,
    [holderPid],
  );
  expect(Number(rows[0]?.count)).toBe(0);
  await holder.query("rollback");
});

async function indexValidity(client: pg.Client, name: string): Promise<boolean | undefined> {
  const { rows } = await client.query<{ indisvalid: boolean }>(
    `select i.indisvalid from pg_index i join pg_class c on c.oid = i.indexrelid
     join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'app' and c.relname = $1`,
    [name],
  );
  return rows[0]?.indisvalid;
}

// Cancels CREATE INDEX CONCURRENTLY while it waits for an older snapshot, which leaves the
// catalog entry behind with indisvalid = false, exactly like an interrupted deploy.
async function seedInvalidIndex(name: string): Promise<void> {
  const snapshotHolder = await connect();
  await snapshotHolder.query("begin isolation level repeatable read");
  await snapshotHolder.query("select 1");

  const builder = await connect();
  const builderPid = (await builder.query<{ pid: number }>("select pg_backend_pid() as pid"))
    .rows[0]?.pid;
  const build = builder
    .query(`create index concurrently ${name} on app.migration_probe (label)`)
    .then(
      () => undefined,
      (error: unknown) => error,
    );

  const observer = await connect();
  const deadline = Date.now() + 20_000;
  for (;;) {
    const { rows } = await observer.query<{ wait_event: string | null }>(
      "select wait_event from pg_stat_activity where pid = $1",
      [builderPid],
    );
    if (rows[0]?.wait_event === "virtualxid") break;
    if (Date.now() > deadline) throw new Error("CREATE INDEX CONCURRENTLY never waited");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await observer.query("select pg_cancel_backend($1)", [builderPid]);
  expect(await build).toMatchObject({ code: "57014" });
  await snapshotHolder.query("rollback");
  expect(await indexValidity(observer, name)).toBe(false);
}

test("a concurrent index ends indisvalid = true and a rerun after interruption completes it", {
  timeout: 60_000,
}, async () => {
  const folder = await withProbeMigrations("concurrent", [createProbe]);
  const concurrent = join(workDir, "concurrent-indexes");
  await mkdir(concurrent);
  await writeFile(
    join(concurrent, "0001_migration_probe_label_idx.sql"),
    "create index concurrently if not exists migration_probe_label_idx on app.migration_probe (label);\n",
  );
  await runMigrations({ ...opts(), migrationsFolder: folder });
  await seedInvalidIndex("migration_probe_label_idx");

  const result = await runMigrations({
    ...opts(),
    migrationsFolder: folder,
    concurrentFolder: concurrent,
  });
  expect(result.concurrent).toEqual(["0001_migration_probe_label_idx.sql"]);
  expect(await indexValidity(await connect(), "migration_probe_label_idx")).toBe(true);

  const rerun = await runMigrations({
    ...opts(),
    migrationsFolder: folder,
    concurrentFolder: concurrent,
  });
  expect(rerun).toEqual({ applied: 0, concurrent: [] });
});

test("the CLI prints one JSON line and exits 0", { timeout: 60_000 }, async () => {
  const child = spawn("pnpm", ["exec", "tsx", "scripts/migrate.ts"], {
    cwd: packageDir,
    env: { ...process.env, DATABASE_URL_MIGRATIONS: databaseUrl },
  });
  let stdout = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
  expect(code).toBe(0);
  const line = JSON.parse(stdout.trim());
  expect(line).toMatchObject({ applied: expect.any(Number), concurrent: [] });
  expect(line.ms).toEqual(expect.any(Number));
});

test("the CLI exits non-zero without DATABASE_URL_MIGRATIONS", { timeout: 60_000 }, async () => {
  const { DATABASE_URL_MIGRATIONS: _omitted, ...env } = process.env;
  const child = spawn("pnpm", ["exec", "tsx", "scripts/migrate.ts"], { cwd: packageDir, env });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
  expect(code).not.toBe(0);
  expect(stderr).toContain("DATABASE_URL_MIGRATIONS");
});
