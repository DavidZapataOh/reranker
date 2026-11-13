import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { cssVariables, resolveVar, tokens, toOpaque } from "../src/tokens.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");

function parseThemeBlock(css: string): Record<string, string> {
  const block = /@theme\s*\{([\s\S]*?)\n\}/.exec(css)?.[1] ?? "";
  const vars: Record<string, string> = {};
  for (const [, name, value] of block.matchAll(/(--[\w-]+):\s*([^;]+);/g)) {
    vars[name as string] = (value as string).trim();
  }
  return vars;
}

function concatImports(path: string): string {
  const dir = dirname(path);
  return read(path)
    .split("\n")
    .map((line) => {
      const file = /@import "(\.\/[^"]+)"/.exec(line)?.[1];
      return file ? read(join(dir, file)) : line;
    })
    .join("\n");
}

function inOrder(css: string, needles: string[]): boolean {
  const positions = needles.map((needle) => css.indexOf(needle));
  return positions.every((p, i) => p >= 0 && (i === 0 || p > (positions[i - 1] as number)));
}

function twRadiusPx(name: string): number {
  const require = createRequire(import.meta.url);
  const css = readFileSync(require.resolve("tailwindcss/theme.css"), "utf8");
  const rem = new RegExp(`--radius-${name}:\\s*([\\d.]+)rem`).exec(css)?.[1];
  return Number(rem) * 16;
}

test("every theme.css variable is mirrored with the same value and vice versa", () => {
  expect(parseThemeBlock(read("src/styles/theme.css"))).toEqual(cssVariables);
});

test("brand palette is verbatim", () => {
  expect(cssVariables["--color-ink-soft"]).toBe("#14211bb3");
  expect(cssVariables["--color-action"]).toBe("var(--color-green)");
  expect(tokens.color.action).toBe("#0f5c45");
  expect(tokens.color.surface).toBe("#ffffff");
  expect(tokens.ease.brand).toBe("cubic-bezier(0.2, 0.8, 0.2, 1)");
  expect(tokens.shadow.float).toBe(
    "0 1px 2px rgb(20 33 27 / 0.05), 0 12px 32px -14px rgb(20 33 27 / 0.22)",
  );
  expect(tokens.fontStack.display).toBe(
    'Nunito, ui-rounded, "SF Pro Rounded", system-ui, sans-serif',
  );
});

test("resolveVar follows var() chains", () => {
  expect(resolveVar("var(--color-text-soft)")).toBe("#14211bb3");
  expect(resolveVar("#fff")).toBe("#fff");
});

test("radius tokens match theme.css and Tailwind defaults", () => {
  expect(cssVariables["--radius-field"]).toBe("22px");
  expect(cssVariables["--radius-card"]).toBe("24px");
  expect(cssVariables["--radius-band"]).toBe("28px");
  expect(twRadiusPx("lg")).toBe(tokens.radius.sm);
  expect(twRadiusPx("xl")).toBe(tokens.radius.md);
  expect(twRadiusPx("2xl")).toBe(tokens.radius.lg);
  expect(twRadiusPx("3xl")).toBe(tokens.radius.card);
});

test("theme does not override Tailwind default radius names used by the landing", () => {
  for (const n of ["xs", "sm", "md", "lg", "xl", "2xl", "3xl"]) {
    expect((cssVariables as Record<string, string>)[`--radius-${n}`]).toBeUndefined();
  }
});

test("toOpaque blends alpha hex", () => {
  expect(toOpaque("#14211bb3", "#faf7f0")).toBe("#59615a");
  expect(toOpaque("#14211b14", "#ffffff")).toBe("#edeeed");
});

test("cascade keeps the reduced-motion caret override after .caret", () => {
  const css = concatImports("src/styles/index.css");
  expect(
    inOrder(css, [
      "@theme",
      "@layer base",
      ".marker",
      ".caret {",
      "@media (prefers-reduced-motion: reduce)",
    ]),
  ).toBe(true);
  const reduced = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
  expect(reduced).toContain(".caret {\n    animation: none;");
});
