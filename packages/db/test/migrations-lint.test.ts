import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { configuredExclusions, listMigrationFiles, squawkRuns } from "../scripts/check";

const packageDir = fileURLToPath(new URL("..", import.meta.url));

function run(command: string, args: string[]) {
  return spawnSync(command, args, {
    cwd: packageDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function squawk(file: string) {
  return run("pnpm", ["exec", "squawk", "--config", ".squawk.toml", file]);
}

test.each([
  ["create-index-existing.sql", "require-concurrent-index-creation"],
  ["add-required-column.sql", "adding-required-field"],
  ["drop-column.sql", "ban-drop-column"],
  ["fk-without-not-valid.sql", "constraint-missing-not-valid"],
  ["concurrent-plain-index.sql", "require-concurrent-index-creation"],
])(
  "%s fails with %s",
  (file, rule) => {
    const result = squawk(`test/squawk-cases/${file}`);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain(rule);
  },
  30_000,
);

test.each(["create-index-new-table.sql", "drop-column-allowed.sql", "concurrent-index.sql"])(
  "%s passes",
  (file) => {
    expect(squawk(`test/squawk-cases/${file}`).status).toBe(0);
  },
  30_000,
);

test("all committed migrations pass db:check and are actually linted", () => {
  const result = run("pnpm", ["db:check"]);
  expect(result.status, result.stdout + result.stderr).toBe(0);
  const expected = listMigrationFiles(join(packageDir, "migrations"));
  const linted = [...result.stdout.matchAll(/Found 0 issues in (\d+) files?\b/g)].reduce(
    (sum, [, count]) => sum + Number(count),
    0,
  );
  expect(linted).toBe(expected.length);
}, 60_000);

test("db:check refuses to pass when no migration file is found", () => {
  const empty = mkdtempSync(join(tmpdir(), "migrations-"));
  try {
    expect(() => listMigrationFiles(empty)).toThrow(/No migration files/);
  } finally {
    rmSync(empty, { recursive: true });
  }
});

test("only the Better Auth migrations skip the column-type rules its CLI decides", () => {
  const runs = squawkRuns(
    ["migrations/0001_core.sql", "migrations/0002_auth.sql", "migrations/concurrent/0001_x.sql"],
    ["require-timeout-settings"],
  );
  expect(runs).toEqual([
    ["migrations/0001_core.sql", "migrations/concurrent/0001_x.sql"],
    [
      "--exclude",
      "require-timeout-settings,prefer-timestamp-tz,prefer-bigint-over-int",
      "migrations/0002_auth.sql",
    ],
  ]);
});

test("the Better Auth run keeps the configured exclusions", () => {
  const toml = readFileSync(join(packageDir, ".squawk.toml"), "utf8");
  expect(configuredExclusions(toml)).toEqual(["require-timeout-settings", "prefer-robust-stmts"]);
});
