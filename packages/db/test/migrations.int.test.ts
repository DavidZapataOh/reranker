import { afterEach, describe, expect, test } from "vitest";
import { type MigrationOptions, runMigrations } from "../scripts/migrate.ts";
import { pgCodeOf } from "../src/errors.ts";
import { createScratchDatabase, scratchMigrations, withClient } from "./support.ts";

const COMMITTED = 2;
const PROBE_TABLE = {
  tag: "9000_migration_probe",
  sql: 'CREATE TABLE "app"."migration_probe" ("id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL, "label" text NOT NULL);',
};

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup(extra = [PROBE_TABLE], concurrent: Record<string, string> = {}) {
  const db = await createScratchDatabase();
  cleanups.push(db.drop);
  const folders = await scratchMigrations(extra, concurrent);
  cleanups.push(folders.cleanup);
  const opts: MigrationOptions = {
    url: db.url,
    migrationsFolder: folders.migrationsFolder,
    concurrentFolder: folders.concurrentFolder,
  };
  return { db, folders, opts };
}

describe("runMigrations", () => {
  test("migrating an empty database applies every migration and a second run applies nothing", async () => {
    const { opts } = await setup([]);
    await expect(runMigrations(opts)).resolves.toEqual({ applied: COMMITTED, concurrent: [] });
    await expect(runMigrations(opts)).resolves.toEqual({ applied: 0, concurrent: [] });
  });

  test("two concurrent runs are serialized by the advisory lock", async () => {
    const { opts } = await setup();
    const [a, b] = await Promise.all([runMigrations(opts), runMigrations(opts)]);
    expect(a.applied + b.applied).toBe(COMMITTED + 1);
    expect(Math.min(a.applied, b.applied)).toBe(0);
  });

  test("fails without hanging or leaving locks when an access exclusive lock is held", async () => {
    const { db, opts } = await setup();
    await runMigrations(opts);
    const alter = await scratchMigrations([
      PROBE_TABLE,
      {
        tag: "9001_probe_note",
        sql: 'ALTER TABLE "app"."migration_probe" ADD COLUMN "note" text;',
      },
    ]);
    cleanups.push(alter.cleanup);

    await withClient(db.url, async (holder) => {
      await holder.query("begin");
      await holder.query("lock table app.migration_probe in access exclusive mode");
      const started = Date.now();
      const error = await runMigrations({ ...opts, ...alter, retries: 3 }).catch((e: unknown) => e);
      const elapsed = Date.now() - started;
      expect(pgCodeOf(error)).toBe("55P03");
      // 3 attempts × 3 s lock_timeout + 1 s and 2 s backoff, plus connection overhead.
      expect(elapsed).toBeGreaterThanOrEqual(9000);
      expect(elapsed).toBeLessThan(16_000);
      const { rows } = await holder.query<{ count: number }>(
        `select count(*)::int as count from pg_locks
          where relation = 'app.migration_probe'::regclass and pid <> pg_backend_pid()`,
      );
      expect(rows[0]?.count).toBe(0);
      await holder.query("rollback");
    });

    await expect(runMigrations({ ...opts, ...alter })).resolves.toMatchObject({ applied: 1 });
  }, 45_000);

  test("an index left invalid by an interrupted build is rebuilt and ends valid", async () => {
    const indexFile = "0001_migration_probe_label.sql";
    const { db, opts } = await setup([PROBE_TABLE], {
      [indexFile]:
        '-- squawk-ignore-file ban-concurrent-index-creation-in-transaction\nCREATE INDEX CONCURRENTLY IF NOT EXISTS "migration_probe_label_idx" ON "app"."migration_probe" USING btree ("label");\n',
    });
    await runMigrations({ ...opts, concurrentFolder: `${opts.concurrentFolder}-none` });

    await withClient(db.url, async (client) => {
      await client.query("insert into app.migration_probe (label) values ('a'), ('a')");
      // A failed concurrent build leaves an invalid index behind, like an interrupted deploy.
      await expect(
        client.query(
          "create unique index concurrently migration_probe_label_idx on app.migration_probe (label)",
        ),
      ).rejects.toMatchObject({ code: "23505" });
    });

    await expect(runMigrations(opts)).resolves.toEqual({ applied: 0, concurrent: [indexFile] });
    const valid = await withClient(db.url, async (client) => {
      const { rows } = await client.query<{ indisvalid: boolean; indisunique: boolean }>(
        `select indisvalid, indisunique from pg_index
          where indexrelid = 'app.migration_probe_label_idx'::regclass`,
      );
      return rows;
    });
    expect(valid).toEqual([{ indisvalid: true, indisunique: false }]);
  });
});
