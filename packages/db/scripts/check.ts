import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
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

function run(command: string, args: string[], cwd: string): void {
  const result = spawnSync(command, args, { cwd, stdio: ["ignore", "inherit", "inherit"] });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

if (import.meta.main) {
  const packageDir = fileURLToPath(new URL("..", import.meta.url));
  run("drizzle-kit", ["check"], packageDir);
  const files = listMigrationFiles(join(packageDir, "migrations"));
  run("squawk", ["--config", ".squawk.toml", ...files], packageDir);
}
