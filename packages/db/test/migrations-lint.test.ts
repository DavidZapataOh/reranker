import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const packageDir = fileURLToPath(new URL("..", import.meta.url));
const squawkBin = fileURLToPath(new URL("../node_modules/.bin/squawk", import.meta.url));

const squawk = (file: string) =>
  spawnSync(squawkBin, ["--config", ".squawk.toml", `test/squawk-cases/${file}`], {
    cwd: packageDir,
    encoding: "utf8",
  });

test.each([
  ["create-index-existing.sql", "require-concurrent-index-creation"],
  ["add-required-column.sql", "adding-required-field"],
  ["drop-column.sql", "ban-drop-column"],
  ["fk-without-not-valid.sql", "constraint-missing-not-valid"],
])("%s fails with %s", (file, rule) => {
  const result = squawk(file);
  expect(result.status, result.stderr).not.toBe(0);
  expect(result.stdout).toContain(rule);
});

test.each(["create-index-new-table.sql", "drop-column-allowed.sql", "concurrent-index.sql"])(
  "%s passes",
  (file) => {
    const result = squawk(file);
    expect(result.status, result.stdout + result.stderr).toBe(0);
  },
);

test("all committed migrations pass db:check", () => {
  const result = spawnSync("pnpm", ["run", "--silent", "db:check"], {
    cwd: packageDir,
    encoding: "utf8",
  });
  expect(result.status, result.stdout + result.stderr).toBe(0);
}, 60_000);
