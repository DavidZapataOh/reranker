import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const packageDir = fileURLToPath(new URL("..", import.meta.url));

function run(command: string, args: string[]) {
  return spawnSync(command, args, { cwd: packageDir, encoding: "utf8" });
}

function squawk(file: string) {
  return run("pnpm", ["exec", "squawk", "--config", ".squawk.toml", file]);
}

test.each([
  ["create-index-existing.sql", "require-concurrent-index-creation"],
  ["add-required-column.sql", "adding-required-field"],
  ["drop-column.sql", "ban-drop-column"],
  ["fk-without-not-valid.sql", "constraint-missing-not-valid"],
])("%s fails with %s", (file, rule) => {
  const result = squawk(`test/squawk-cases/${file}`);
  expect(result.status).not.toBe(0);
  expect(result.stdout).toContain(rule);
});

test.each(["create-index-new-table.sql", "drop-column-allowed.sql"])("%s passes", (file) => {
  expect(squawk(`test/squawk-cases/${file}`).status).toBe(0);
});

test("all committed migrations pass db:check", () => {
  const result = run("pnpm", ["db:check"]);
  expect(result.status, result.stdout + result.stderr).toBe(0);
});
