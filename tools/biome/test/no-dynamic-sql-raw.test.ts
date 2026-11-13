import { describe, expect, test } from "vitest";
import { biomeCi, restrictedImports } from "./biome-ci.ts";

const MESSAGE =
  "sql.raw only takes a string literal. Pass values through the sql`` template so they are sent as parameters.";

function sqlRaw(path: string, code: string) {
  const { exitCode, diagnostics } = biomeCi(path, code);
  return { exitCode, flagged: diagnostics.filter((d) => d.message === MESSAGE).length };
}

const prelude = 'import { sql } from "drizzle-orm";\n';

describe("no-dynamic-sql-raw", () => {
  test.each([
    "export const q = (name: string) => sql.raw(name);",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: source text under test
    "export const q = (name: string) => sql.raw(`drop table ${name}`);",
    'export const q = (name: string) => sql.raw("drop table " + name);',
    "export const q = (o: { t: string }) => sql.raw(o.t);",
    "export const q = (f: () => string) => sql.raw(f());",
    "export const q = (t: (s: TemplateStringsArray) => string) => sql.raw(t`x`);",
  ])("flags %s", (code) => {
    for (const path of ["apps/web/src/a.ts", "packages/db/test/a.int.test.ts"]) {
      const result = sqlRaw(path, `${prelude}${code}`);
      expect(result.flagged).toBe(1);
      expect(result.exitCode).not.toBe(0);
    }
  });

  test.each([
    'export const q = sql.raw("select 1");',
    "export const q = sql.raw('select 1');",
    "export const q = sql.raw(`\n  create table app.t (id uuid)\n`);",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: source text under test
    "export const q = (id: string) => sql`select ${id}`;",
    "export const q = (s: string) => String.raw({ raw: [s] });",
  ])("allows %s", (code) => {
    expect(sqlRaw("apps/web/src/a.ts", `${prelude}${code}`)).toEqual({ exitCode: 0, flagged: 0 });
  });
});

describe("auth adapter import", () => {
  const code = 'import { authDb } from "@reranker/db/auth-adapter";\nexport { authDb };';

  test.each([
    "apps/web/src/a.ts",
    "apps/web/src/a.test.ts",
    "packages/db/src/a.ts",
    "packages/schema/src/a.ts",
    "scripts/a.ts",
  ])("blocks it in %s", (path) => {
    const result = biomeCi(path, code);
    expect(restrictedImports(result.diagnostics)).toEqual([
      "The connection without tenant or system settings is only for packages/auth.",
    ]);
    expect(result.exitCode).not.toBe(0);
  });

  test.each(["packages/auth/src/a.ts", "packages/auth/src/a.test.ts"])(
    "allows it in %s",
    (path) => {
      expect(biomeCi(path, code)).toMatchObject({ exitCode: 0, diagnostics: [] });
    },
  );

  test("packages/auth keeps the other import restrictions", () => {
    const zod = biomeCi("packages/auth/src/a.test.ts", "import * as z from 'zod';\nexport { z };");
    expect(restrictedImports(zod.diagnostics)[0]).toContain("@reranker/schema");
    const testing = biomeCi(
      "packages/auth/src/a.ts",
      "import { env } from '@reranker/testing';\nexport { env };",
    );
    expect(restrictedImports(testing.diagnostics)).toEqual(["Test-only package."]);
  });
});
