import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { runMigrations } from "../scripts/migrate.ts";
import { connect, withScratchDatabase } from "./support/scratch-database.ts";

const MIGRATIONS = fileURLToPath(new URL("../migrations", import.meta.url));

type Journal = { entries: { idx: number; when: number; tag: string; breakpoints: boolean }[] };

const folders: string[] = [];

afterEach(async () => {
  await Promise.all(folders.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A copy of the committed migrations plus test-only ones, so probe tables never reach migrations/. */
async function migrationsWith(
  extra: Record<string, string>,
  concurrent: Record<string, string> = {},
) {
  const dir = await mkdtemp(join(tmpdir(), "reranker-migrations-"));
  folders.push(dir);
  await cp(MIGRATIONS, dir, { recursive: true });
  const journalPath = join(dir, "meta", "_journal.json");
  const journal = JSON.parse(await readFile(journalPath, "utf8")) as Journal;
  for (const [tag, sql] of Object.entries(extra)) {
    const last = journal.entries.at(-1);
    journal.entries.push({
      idx: journal.entries.length,
      when: (last?.when ?? 0) + 1000,
      tag,
      breakpoints: true,
    });
    await writeFile(join(dir, `${tag}.sql`), sql);
  }
  await writeFile(journalPath, JSON.stringify(journal));
  const concurrentFolder = join(dir, "concurrent");
  await mkdir(concurrentFolder, { recursive: true });
  for (const [file, sql] of Object.entries(concurrent)) {
    await writeFile(join(concurrentFolder, file), sql);
  }
  return { migrationsFolder: dir, concurrentFolder, pending: journal.entries.length };
}

const PROBE_TABLE = {
  "9000_migration_probe": `create table app.migration_probe (id integer primary key, label text);
--> statement-breakpoint
insert into app.migration_probe select i, 'label-' || (i % 50) from generate_series(1, 500) i;`,
};

describe("runMigrations", () => {
  test("an empty database gets every migration and a second run applies nothing", async () => {
    await withScratchDatabase(async (url) => {
      const { migrationsFolder, concurrentFolder, pending } = await migrationsWith({});
      const first = await runMigrations({ url, migrationsFolder, concurrentFolder });
      expect(first.applied).toBe(pending);
      const second = await runMigrations({ url, migrationsFolder, concurrentFolder });
      expect(second).toEqual({ applied: 0, concurrent: [] });
    });
  });

  test("two concurrent runs are serialized by the advisory lock", async () => {
    await withScratchDatabase(async (url) => {
      const { migrationsFolder, concurrentFolder, pending } = await migrationsWith({});
      const [a, b] = await Promise.all([
        runMigrations({ url, migrationsFolder, concurrentFolder }),
        runMigrations({ url, migrationsFolder, concurrentFolder }),
      ]);
      expect(a.applied + b.applied).toBe(pending);
      expect(Math.min(a.applied, b.applied)).toBe(0);
    });
  });

  test("fails without hanging or leaving locks when the table stays locked", async () => {
    await withScratchDatabase(async (url) => {
      const base = await migrationsWith(PROBE_TABLE);
      await runMigrations({ url, ...base });
      const next = await migrationsWith({
        ...PROBE_TABLE,
        "9001_migration_probe_note": "alter table app.migration_probe add column note text;",
      });

      const holder = await connect(url);
      try {
        await holder.query("begin");
        await holder.query("lock table app.migration_probe in access exclusive mode");
        const started = Date.now();
        await expect(
          runMigrations({ url, ...next, retries: 3, lockTimeout: "1s" }),
        ).rejects.toThrow(/lock timeout/);
        // 3 attempts of 1 s plus 1 s and 2 s of backoff, with slack for the network.
        expect(Date.now() - started).toBeLessThan(10_000);

        const { rows } = await holder.query(
          `select count(*)::int as locks from pg_locks l join pg_stat_activity a using (pid)
           where a.datname = current_database() and l.pid <> pg_backend_pid()`,
        );
        expect(rows[0].locks).toBe(0);
      } finally {
        await holder.query("rollback");
        await holder.end();
      }

      expect((await runMigrations({ url, ...next })).applied).toBe(1);
    });
  });

  test("a concurrent index ends valid and replaces one left invalid by an interrupted build", async () => {
    await withScratchDatabase(async (url) => {
      const folder = await migrationsWith(PROBE_TABLE, {
        "0000_migration_probe_label.sql":
          "create index concurrently if not exists migration_probe_label_idx on app.migration_probe (label);",
      });
      await runMigrations({
        ...folder,
        url,
        concurrentFolder: join(folder.migrationsFolder, "none"),
      });

      const client = await connect(url);
      try {
        // Duplicate labels make the unique build fail after the catalog entry exists: an invalid index.
        await expect(
          client.query(
            "create unique index concurrently migration_probe_label_idx on app.migration_probe (label)",
          ),
        ).rejects.toThrow();
        expect(await isValid(client)).toBe(false);

        const result = await runMigrations({ ...folder, url });
        expect(result).toEqual({ applied: 0, concurrent: ["0000_migration_probe_label.sql"] });
        expect(await isValid(client)).toBe(true);
      } finally {
        await client.end();
      }
    });
  });

  test("a concurrent build that times out behind an older transaction is rebuilt on retry", async () => {
    await withScratchDatabase(async (url) => {
      const folder = await migrationsWith(PROBE_TABLE, {
        "0000_migration_probe_label.sql":
          "create index concurrently if not exists migration_probe_label_idx on app.migration_probe (label);",
      });
      await runMigrations({
        ...folder,
        url,
        concurrentFolder: join(folder.migrationsFolder, "none"),
      });

      // A row lock held open makes the build wait for this transaction after it has already
      // committed the (invalid) catalog entry; it is released during the first backoff.
      const holder = await connect(url);
      await holder.query("begin");
      await holder.query("update app.migration_probe set label = label where id = 1");
      const release = setTimeout(() => {
        void holder.query("rollback");
      }, 1500);
      try {
        const result = await runMigrations({ ...folder, url, lockTimeout: "1s", retries: 3 });
        expect(result.concurrent).toEqual(["0000_migration_probe_label.sql"]);
        expect(await isValid(holder)).toBe(true);
      } finally {
        clearTimeout(release);
        await holder.end();
      }
    });
  });
});

async function isValid(client: Awaited<ReturnType<typeof connect>>): Promise<boolean> {
  const { rows } = await client.query(
    `select i.indisvalid from pg_index i join pg_class c on c.oid = i.indexrelid
     join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'app' and c.relname = 'migration_probe_label_idx'`,
  );
  return rows[0].indisvalid;
}
