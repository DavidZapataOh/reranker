import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

// Files are listed explicitly because Squawk reads stdin when a pattern matches nothing and
// reports success for zero files, so a moved directory or a typo would pass silently.
export function listMigrationFiles(migrationsDir: string): string[] {
  const sqlIn = (dir: string) =>
    existsSync(dir)
      ? readdirSync(dir)
          .filter((name) => name.endsWith(".sql"))
          .sort()
          .map((name) => join(dir, name))
      : [];
  const main = sqlIn(migrationsDir);
  if (main.length === 0) throw new Error(`No migration files found in ${migrationsDir}`);
  return [...main, ...sqlIn(join(migrationsDir, "concurrent"))];
}

// Column types in these files come from the Better Auth CLI (timestamp, integer), which we do
// not hand-edit; every other rule still applies to them.
const BETTER_AUTH_MIGRATIONS = new Set(["0002_auth.sql"]);
const BETTER_AUTH_TYPE_RULES = ["prefer-timestamp-tz", "prefer-bigint-over-int"];

/** The excluded_rules list of .squawk.toml, because a command-line --exclude replaces it. */
export function configuredExclusions(toml: string): string[] {
  const list = /^excluded_rules\s*=\s*\[([\s\S]*?)\]/m.exec(toml)?.[1] ?? "";
  return [...list.replace(/#.*$/gm, "").matchAll(/"([^"]+)"/g)].map(([, rule]) => rule as string);
}

/** Squawk argument lists: one run for our migrations, one for the Better Auth generated ones. */
export function squawkRuns(files: string[], configured: string[]): string[][] {
  const generated = files.filter((file) => BETTER_AUTH_MIGRATIONS.has(basename(file)));
  const own = files.filter((file) => !generated.includes(file));
  const exclude = [...configured, ...BETTER_AUTH_TYPE_RULES].join(",");
  return [own, ...(generated.length ? [["--exclude", exclude, ...generated]] : [])];
}

function run(command: string, args: string[], cwd: string): void {
  const result = spawnSync(command, args, { cwd, stdio: ["ignore", "inherit", "inherit"] });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

if (import.meta.main) {
  const packageDir = fileURLToPath(new URL("..", import.meta.url));
  run("drizzle-kit", ["check"], packageDir);
  const files = listMigrationFiles(join(packageDir, "migrations"));
  const configured = configuredExclusions(readFileSync(join(packageDir, ".squawk.toml"), "utf8"));
  for (const args of squawkRuns(files, configured))
    run("squawk", ["--config", ".squawk.toml", ...args], packageDir);
}
