import { describe, expect, test } from "vitest";
import { restrictedImports, biomeCi as run } from "./biome-ci.ts";

const MESSAGE =
  "Use the country registry (@reranker/i18n/countries) instead of a hard-coded country, currency, locale, time zone or payment provider.";

function biomeCi(path: string, code: string) {
  const { exitCode, diagnostics } = run(path, code);
  return {
    exitCode,
    countryLiterals: diagnostics.filter((d) => d.message === MESSAGE).length,
    restrictedImports: restrictedImports(diagnostics),
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
    ['export type X = "COP";'],
    ['export const o = { "CO": 1 };'],
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
      "export const x = { CO: 1 };",
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
