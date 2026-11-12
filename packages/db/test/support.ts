import { randomBytes } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getTestDatabaseUrl } from "@reranker/testing/neon";
import pg from "pg";

export const MIGRATIONS_FOLDER = join(import.meta.dirname, "..", "migrations");

export async function withClient<T>(
  url: string,
  fn: (client: pg.Client) => Promise<T>,
): Promise<T> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

export const ownerUrl = () => getTestDatabaseUrl("migrations");

// A database of its own on the CI branch, so runner tests start empty without touching the
// schema the other suites run against. Roles are cluster-wide and shared with it.
export async function createScratchDatabase(): Promise<{ url: string; drop: () => Promise<void> }> {
  const name = `scratch_${randomBytes(6).toString("hex")}`;
  await withClient(ownerUrl(), (c) => c.query(`create database ${name}`));
  const url = new URL(ownerUrl());
  url.pathname = `/${name}`;
  return {
    url: url.toString(),
    drop: async () => {
      await withClient(ownerUrl(), (c) => c.query(`drop database if exists ${name} with (force)`));
    },
  };
}

type ExtraMigration = { tag: string; sql: string };

// Copies the committed migrations and appends test-only ones, so probe tables never reach migrations/.
export async function scratchMigrations(
  extra: ExtraMigration[] = [],
  concurrent: Record<string, string> = {},
): Promise<{ migrationsFolder: string; concurrentFolder: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "reranker-migrations-"));
  await cp(MIGRATIONS_FOLDER, dir, { recursive: true });
  const journalPath = join(dir, "meta", "_journal.json");
  const journal = JSON.parse(await readFile(journalPath, "utf8")) as {
    entries: { idx: number; version: string; when: number; tag: string; breakpoints: boolean }[];
  };
  for (const migration of extra) {
    const last = journal.entries.at(-1);
    journal.entries.push({
      idx: (last?.idx ?? -1) + 1,
      version: "7",
      when: (last?.when ?? Date.now()) + 1000,
      tag: migration.tag,
      breakpoints: true,
    });
    await writeFile(join(dir, `${migration.tag}.sql`), migration.sql);
  }
  await writeFile(journalPath, JSON.stringify(journal));
  const concurrentFolder = join(dir, "concurrent");
  await mkdir(concurrentFolder, { recursive: true });
  for (const [file, sql] of Object.entries(concurrent)) {
    await writeFile(join(concurrentFolder, file), sql);
  }
  return {
    migrationsFolder: dir,
    concurrentFolder,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

export function passwordOf(url: string): string {
  return decodeURIComponent(new URL(url).password);
}
