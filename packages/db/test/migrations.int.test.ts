import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getTestDatabaseUrl } from "@reranker/testing/neon";
import { afterAll, beforeAll, expect, test } from "vitest";
import { type MigrationOptions, runMigrations } from "../scripts/migrate.ts";
import { pgErrorCode } from "../src/errors.ts";
import { connect, uniqueSuffix, withClient } from "./support.ts";

// Probe migrations live in a scratch schema with their own journal table, never in migrations/.
const suffix = uniqueSuffix();
const scratch = `migration_probe_${suffix}`;
const scratchSchemas: string[] = [scratch];
let workDir: string;

type Migration = { tag: string; sql: string[] };

async function writeMigrations(name: string, migrations: Migration[], concurrent: string[] = []) {
  const dir = join(workDir, name);
  await mkdir(join(dir, "meta"), { recursive: true });
  await mkdir(join(dir, "concurrent"), { recursive: true });
  const entries = migrations.map((m, idx) => ({
    idx,
    version: "7",
    when: 1_700_000_000_000 + idx,
    tag: m.tag,
    breakpoints: true,
  }));
  await writeFile(
    join(dir, "meta", "_journal.json"),
    JSON.stringify({ version: "7", dialect: "postgresql", entries }),
  );
  for (const m of migrations) {
    await writeFile(join(dir, `${m.tag}.sql`), m.sql.join("\n--> statement-breakpoint\n"));
  }
  for (const [i, sql] of concurrent.entries()) {
    await writeFile(join(dir, "concurrent", `${String(i).padStart(4, "0")}_probe.sql`), sql);
  }
  return dir;
}

function options(dir: string, journal: string, extra: Partial<MigrationOptions> = {}) {
  scratchSchemas.push(journal);
  return {
    url: getTestDatabaseUrl("migrations"),
    migrationsFolder: dir,
    concurrentFolder: join(dir, "concurrent"),
    migrationsSchema: journal,
    ...extra,
  };
}

const base: Migration[] = [
  { tag: "0000_probe", sql: [`create schema "${scratch}"`] },
  {
    tag: "0001_table",
    sql: [`create table "${scratch}"."t" (id int primary key, label text)`],
  },
];

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), "migrations-"));
});

afterAll(async () => {
  await withClient("migrations", async (owner) => {
    for (const schema of scratchSchemas) {
      await owner.query(`drop schema if exists ${owner.escapeIdentifier(schema)} cascade`);
    }
  });
  await rm(workDir, { recursive: true, force: true });
});

test("the committed migrations are fully applied on this branch and rerunning applies nothing", async () => {
  const result = await runMigrations({
    url: getTestDatabaseUrl("migrations"),
    migrationsFolder: fileURLToPath(new URL("../migrations", import.meta.url)),
    concurrentFolder: fileURLToPath(new URL("../migrations/concurrent", import.meta.url)),
  });
  expect(result.applied).toBe(0);
});

test("migrate on an empty journal applies every migration and a second run applies nothing", async () => {
  const dir = await writeMigrations("fresh", base);
  const opts = options(dir, `journal_a_${suffix}`);
  expect(await runMigrations(opts)).toEqual({ applied: 2, concurrent: [] });
  expect(await runMigrations(opts)).toEqual({ applied: 0, concurrent: [] });
});

test("two concurrent runs are serialized by the advisory lock", async () => {
  const dir = await writeMigrations("concurrent-runs", [
    { tag: "0000_probe", sql: [`create table "${scratch}"."serialized" (id int primary key)`] },
  ]);
  const opts = options(dir, `journal_b_${suffix}`);
  const [a, b] = await Promise.all([runMigrations(opts), runMigrations(opts)]);
  expect(a.applied + b.applied).toBe(1);
  expect(Math.min(a.applied, b.applied)).toBe(0);
});

test("fails without hanging when an ACCESS EXCLUSIVE lock is held, and leaves no lock behind", async () => {
  const dir = await writeMigrations("locked", [
    { tag: "0000_alter", sql: [`alter table "${scratch}"."t" add column note text`] },
  ]);
  const opts = options(dir, `journal_c_${suffix}`, { lockTimeout: "500ms", retries: 3 });
  const holder = await connect("migrations");
  try {
    await holder.query("begin");
    await holder.query(`lock table "${scratch}"."t" in access exclusive mode`);
    const started = performance.now();
    const error = await runMigrations(opts).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    // 3 attempts of 0.5 s plus 1 s and 2 s of backoff.
    expect(performance.now() - started).toBeLessThan(3 * 500 + 1000 + 2000 + 2000);
    expect(pgErrorCode(error)).toBe("55P03");
  } finally {
    await holder.query("rollback");
    await holder.end();
  }
  await withClient("migrations", async (owner) => {
    const lock = await owner.query(
      "select pg_try_advisory_lock(hashtext('reranker.migrate')) as free",
    );
    expect(lock.rows[0]?.free).toBe(true);
    await owner.query("select pg_advisory_unlock(hashtext('reranker.migrate'))");
  });
});

test("a concurrent index left invalid by an interrupted build is rebuilt and ends valid", async () => {
  const index = `t_label_${suffix}_key`;
  await withClient("migrations", async (owner) => {
    await owner.query(`insert into "${scratch}"."t" values (1, 'dup'), (2, 'dup')`);
    // A failed unique build leaves the same invalid index an interrupted one does.
    await expect(
      owner.query(`create unique index concurrently "${index}" on "${scratch}"."t" (label)`),
    ).rejects.toMatchObject({ code: "23505" });
    await owner.query(`delete from "${scratch}"."t" where id = 2`);
  });
  expect(await indexValidity(index)).toBe(false);

  const dir = await writeMigrations(
    "with-concurrent",
    [],
    [
      `-- squawk-disable-assume-in-transaction\ncreate unique index concurrently if not exists "${index}" on "${scratch}"."t" (label);`,
    ],
  );
  const result = await runMigrations(options(dir, `journal_d_${suffix}`));
  expect(result.concurrent).toEqual(["0000_probe.sql"]);
  expect(await indexValidity(index)).toBe(true);
});

async function indexValidity(name: string): Promise<boolean | undefined> {
  return withClient("migrations", async (owner) => {
    const result = await owner.query<{ indisvalid: boolean }>(
      `select i.indisvalid from pg_index i join pg_class c on c.oid = i.indexrelid where c.relname = $1`,
      [name],
    );
    return result.rows[0]?.indisvalid;
  });
}
