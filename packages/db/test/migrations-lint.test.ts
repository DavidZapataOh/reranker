import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const PACKAGE = fileURLToPath(new URL("..", import.meta.url));

function squawk(...paths: string[]) {
  const result = spawnSync("pnpm", ["exec", "squawk", "--config", ".squawk.toml", ...paths], {
    cwd: PACKAGE,
    encoding: "utf8",
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

describe("squawk", () => {
  test.each([
    ["create-index-existing.sql", "require-concurrent-index-creation"],
    ["add-required-column.sql", "adding-required-field"],
    ["drop-column.sql", "ban-drop-column"],
    ["fk-without-not-valid.sql", "adding-foreign-key-constraint"],
  ])("rejects %s with %s", (file, rule) => {
    const result = squawk(`test/squawk-cases/${file}`);
    expect(result.status).not.toBe(0);
    expect(result.output).toContain(rule);
  });

  test.each(["create-index-new-table.sql", "drop-column-allowed.sql", "concurrent-index.sql"])(
    "accepts %s",
    (file) => {
      const result = squawk(`test/squawk-cases/${file}`);
      expect(result.output).not.toMatch(/warning|error/i);
      expect(result.status).toBe(0);
    },
  );

  test("every committed migration passes db:check", () => {
    const result = spawnSync("pnpm", ["run", "--silent", "db:check"], {
      cwd: PACKAGE,
      encoding: "utf8",
    });
    expect(`${result.stdout}${result.stderr}`).not.toMatch(/warning\[|error\[/);
    expect(result.status).toBe(0);
  });
});
