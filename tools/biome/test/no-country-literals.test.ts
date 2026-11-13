import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, test } from "vitest";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const PLUGINS = fileURLToPath(new URL("../", import.meta.url));
const BIOME = fileURLToPath(new URL("../node_modules/.bin/biome", import.meta.url));
const MESSAGE =
  "Use the country registry (@reranker/i18n/countries) instead of a hard-coded country, currency, locale, time zone or payment provider.";

type Diagnostic = { category: string; message: string; location: { path: string } };

const workspaces: string[] = [];
afterAll(() => {
  for (const dir of workspaces) rmSync(dir, { recursive: true, force: true });
});

// Runs the repository's own configuration on one file placed at `path` in a scratch copy, so
// the path-based includes and overrides behave exactly as they do in CI.
function biomeCi(path: string, code: string) {
  const dir = mkdtempSync(join(tmpdir(), "biome-plugin-"));
  workspaces.push(dir);
  cpSync(join(ROOT, "biome.json"), join(dir, "biome.json"));
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
  const { diagnostics } = JSON.parse(result.stdout) as { diagnostics: Diagnostic[] };
  return {
    exitCode: result.status,
    countryLiterals: diagnostics.filter((d) => d.message === MESSAGE).length,
    restrictedImports: diagnostics
      .filter((d) => d.category === "lint/style/noRestrictedImports")
      .map((d) => d.message),
  };
}

describe("no-country-literals", () => {
  test.each([
    ["const c = 'COP';"],
    ['const c = "CO";'],
    ["const c = 'EUR';"],
    ["const z = `America/Bogota`;"],
    ["export const html = <html lang='es-CO' />;"],
    ['export const html = <html lang="es-CO" />;'],
    ["pay('wompi');"],
    ["invoice({ provider: 'alegra' });"],
    ["checkout('paddle');"],
  ])("flags %s in apps/web/src/app/page.tsx", (code) => {
    const result = biomeCi("apps/web/src/app/page.tsx", code);
    expect(result.countryLiterals).toBe(1);
    expect(result.exitCode).not.toBe(0);
  });

  test.each([
    "packages/i18n/src/countries/co.ts",
    "packages/i18n/src/locales.ts",
    "packages/schema/src/country.ts",
  ])("allows the literal inside the registry file %s", (path) => {
    expect(biomeCi(path, "export const x = 'COP';")).toMatchObject({
      exitCode: 0,
      countryLiterals: 0,
    });
  });

  test.each(["apps/web/src/x.test.ts", "apps/web/src/x.test.tsx", "apps/web/e2e/pricing.spec.ts"])(
    "allows it in the test %s",
    (path) => {
      expect(biomeCi(path, "export const c = 'COP';")).toMatchObject({
        exitCode: 0,
        countryLiterals: 0,
      });
    },
  );

  test("does not flag unrelated strings, substitutions, keys, types or USD", () => {
    const code = [
      "export const s = 'COPIA';",
      "export const t = 'co';",
      "export const u = 'USD';",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: source text under test
      "export const v = `COP ${s}`;",
      "export const w = { COP: 1 };",
      'export type T = "COP";',
    ].join("\n");
    expect(biomeCi("apps/web/src/a.ts", code)).toMatchObject({ exitCode: 0, countryLiterals: 0 });
  });
});

describe("zod imports", () => {
  test.each([
    "import * as z from 'zod';\nexport { z };",
    "import { es } from 'zod/locales';\nexport { es };",
  ])("blocks %s outside packages/schema", (code) => {
    const result = biomeCi("apps/web/src/a.ts", code);
    expect(result.restrictedImports).toHaveLength(1);
    expect(result.restrictedImports[0]).toContain("@reranker/schema");
    expect(result.exitCode).not.toBe(0);
  });

  test("allows zod inside packages/schema", () => {
    const result = biomeCi("packages/schema/src/z.ts", "import * as z from 'zod';\nexport { z };");
    expect(result).toMatchObject({ exitCode: 0, restrictedImports: [] });
  });

  test.each(["apps/web/src/a.ts", "packages/schema/src/a.ts"])(
    "still keeps the test-only package out of %s",
    (path) => {
      const result = biomeCi(path, "import { env } from '@reranker/testing';\nexport { env };");
      expect(result.restrictedImports).toEqual(["Test-only package."]);
    },
  );
});
