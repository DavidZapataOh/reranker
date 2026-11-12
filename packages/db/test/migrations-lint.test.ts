import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const root = join(import.meta.dirname, "..");

function run(command: string, args: string[]) {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8" });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

const squawk = (file: string) =>
  run("pnpm", ["exec", "squawk", "--config", ".squawk.toml", `test/squawk-cases/${file}`]);

describe("squawk", () => {
  test.each([
    ["create-index-existing.sql", "require-concurrent-index-creation"],
    ["add-required-column.sql", "adding-required-field"],
    ["drop-column.sql", "ban-drop-column"],
    ["fk-without-not-valid.sql", "constraint-missing-not-valid"],
  ])("%s fails with %s", (file, rule) => {
    const result = squawk(file);
    expect(result.status).not.toBe(0);
    expect(result.output).toContain(rule);
  });

  test.each(["create-index-new-table.sql", "drop-column-allowed.sql", "concurrent-index.sql"])(
    "%s passes",
    (file) => {
      const result = squawk(file);
      expect(result.output).toContain("Found 0 issues");
      expect(result.status).toBe(0);
    },
  );
});

test("every committed migration passes db:check", () => {
  const result = run("pnpm", ["run", "--silent", "db:check"]);
  expect(result.output).toContain("Found 0 issues");
  expect(result.status).toBe(0);
}, 60_000);
