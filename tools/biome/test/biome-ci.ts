import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll } from "vitest";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const PLUGINS = fileURLToPath(new URL("../", import.meta.url));
const BIOME = fileURLToPath(new URL("../node_modules/.bin/biome", import.meta.url));

export type Diagnostic = { category: string; message: string; location: { path: string } };

const workspaces: string[] = [];
afterAll(() => {
  for (const dir of workspaces) rmSync(dir, { recursive: true, force: true });
});

// Runs the repository's own configuration on one file placed at `path` in a scratch copy, so
// the path-based includes and overrides behave exactly as they do in CI.
export function biomeCi(
  path: string,
  code: string,
): { exitCode: number | null; diagnostics: Diagnostic[] } {
  const dir = mkdtempSync(join(tmpdir(), "biome-plugin-"));
  workspaces.push(dir);
  cpSync(join(ROOT, "biome.jsonc"), join(dir, "biome.jsonc"));
  mkdirSync(join(dir, "tools/biome"), { recursive: true });
  for (const plugin of readdirSync(PLUGINS).filter((name) => name.endsWith(".grit"))) {
    cpSync(join(PLUGINS, plugin), join(dir, "tools/biome", plugin));
  }
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), code);
  // Formatting and import sorting are not under test; the snippets stay readable without them.
  const result = spawnSync(
    BIOME,
    [
      "ci",
      "--vcs-enabled=false",
      "--formatter-enabled=false",
      "--assist-enabled=false",
      "--reporter=json",
      "--colors=off",
      path,
    ],
    { cwd: dir, encoding: "utf8" },
  );
  let report: { diagnostics: Diagnostic[] };
  try {
    report = JSON.parse(result.stdout);
  } catch {
    throw new Error(
      `Biome produced no JSON report (exit ${result.status}): ${result.stderr || result.stdout}`,
    );
  }
  return { exitCode: result.status, diagnostics: report.diagnostics };
}

export function restrictedImports(diagnostics: Diagnostic[]): string[] {
  return diagnostics
    .filter((d) => d.category === "lint/style/noRestrictedImports")
    .map((d) => d.message);
}
