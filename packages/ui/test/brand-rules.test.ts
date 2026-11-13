import { expect, test } from "vitest";
import { copy } from "../src/copy.ts";
import { cssVariables } from "../src/tokens.ts";
import { readSources } from "./source.ts";

type Source = { path: string; text: string };

const sources = await readSources(["src/**/*.{ts,tsx,css}"]);
const planted = (text: string, path = "src/planted.tsx"): Source[] => [{ path, text }];

function matches(list: Source[], pattern: RegExp, allowed: string[] = []): string[] {
  const found: string[] = [];
  for (const { path, text } of list) {
    if (allowed.includes(path)) continue;
    const re = new RegExp(pattern.source, `${pattern.flags.replace("g", "")}g`);
    for (const m of text.matchAll(re)) {
      const line = text.slice(0, m.index).split("\n").length;
      found.push(`${path}:${line} ${m[0]}`);
    }
  }
  return found;
}

const hexOutsideTheme = (list: Source[]) =>
  matches(list, /#[0-9a-f]{3,8}\b/i, ["src/styles/theme.css", "src/tokens.ts"]);
const amberText = (list: Source[]) => [
  ...matches(list, /\b(?:text|fill|stroke|decoration|caret)-amber\b/),
  ...matches(list, /color:\s*(?:#f2b544|var\(--color-amber\))/i),
];
const violetClasses = (list: Source[]) => matches(list, /\b(?:violet|purple|fuchsia)-\d{2,3}\b/);
const whatsappGreen = (list: Source[]) => matches(list, /#25d366/i);
const gradients = (list: Source[]) =>
  matches(
    list,
    /bg-(?:linear|radial|conic)-|bg-gradient-|(?:linear|radial|conic)-gradient\((?!\s*transparent)/,
    ["src/styles/marks.css"],
  );
const innerHtml = (list: Source[]) => matches(list, /dangerouslySetInnerHTML/);
const humanContact = (values: string[]) =>
  values.filter((value) => /llam|reuni|demo|agend|whatsapp/i.test(value));

const actionVariantsPath = "src/actions/variants.ts";
function actionBackground(list: Source[]): string[] {
  const found: string[] = [];
  let primaryUses = 0;
  for (const { path, text } of list) {
    for (const m of text.matchAll(/(?<![\w-])bg-action(?![\w-])/g)) {
      const line = text.slice(0, m.index).split("\n").length;
      const key = [...text.slice(0, m.index).matchAll(/(?:^|[\n{,])\s*["']?([\w-]+)["']?\s*:/g)].at(
        -1,
      )?.[1];
      if (path !== actionVariantsPath) found.push(`${path}:${line} outside the variants file`);
      else if (key !== "primary") found.push(`${path}:${line} inside "${key}"`);
      else primaryUses += 1;
    }
  }
  if (primaryUses > 1) found.push(`${actionVariantsPath} paints bg-action ${primaryUses} times`);
  return found;
}

function hueAndSaturation(hex: string): { hue: number; saturation: number } {
  const digits = hex.slice(1);
  const full = digits.length <= 4 ? [...digits].map((c) => c + c).join("") : digits;
  const [r, g, b] = [0, 2, 4].map((i) => Number.parseInt(full.slice(i, i + 2), 16) / 255) as [
    number,
    number,
    number,
  ];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  if (delta === 0) return { hue: 0, saturation: 0 };
  const lightness = (max + min) / 2;
  const saturation = delta / (1 - Math.abs(2 * lightness - 1));
  const sector =
    max === r ? ((g - b) / delta) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
  return { hue: (((sector * 60) % 360) + 360) % 360, saturation };
}
const resolveIn = (variables: Record<string, string>, value: string): string => {
  const ref = /^var\((--[\w-]+)\)$/.exec(value)?.[1];
  return ref === undefined ? value : resolveIn(variables, variables[ref] ?? "");
};
const purpleColors = (variables: Record<string, string>) =>
  Object.entries(variables).flatMap(([name, value]) => {
    const resolved = resolveIn(variables, value);
    if (!/^#[0-9a-f]{3,8}$/i.test(resolved)) return [];
    const { hue, saturation } = hueAndSaturation(resolved);
    return saturation > 0.15 && hue >= 250 && hue <= 320 ? [`${name} ${resolved}`] : [];
  });

test("the source set is not empty", () => {
  expect(sources.map((s) => s.path)).toContain("src/styles/theme.css");
});

test("no hex colors outside theme.css and tokens.ts", () => {
  expect(hexOutsideTheme(sources)).toEqual([]);
  expect(hexOutsideTheme(planted("const c = '#0f5c45';"))).toHaveLength(1);
  expect(hexOutsideTheme(planted("a{color:#fff}", "src/styles/x.css"))).toHaveLength(1);
  expect(hexOutsideTheme(planted("--c: #0f5c45;", "src/styles/theme.css"))).toEqual([]);
});

test("amber is never text", () => {
  expect(amberText(sources)).toEqual([]);
  expect(amberText(planted('<p className="text-amber">'))).toHaveLength(1);
  expect(amberText(planted('<svg className="fill-amber stroke-amber">'))).toHaveLength(2);
  expect(amberText(planted("a { color: var(--color-amber); }", "src/x.css"))).toHaveLength(1);
  expect(amberText(planted("a { color: #F2B544; }", "src/x.css"))).toHaveLength(1);
  expect(amberText(planted('<i className="bg-amber">'))).toEqual([]);
});

test("no violet, purple or fuchsia", () => {
  expect(violetClasses(sources)).toEqual([]);
  expect(violetClasses(planted('<p className="bg-violet-500 text-purple-600">'))).toHaveLength(2);
  expect(violetClasses(planted('<p className="ring-fuchsia-300">'))).toHaveLength(1);

  expect(purpleColors(cssVariables)).toEqual([]);
  expect(purpleColors({ "--color-x": "#8b5cf6" })).toEqual(["--color-x #8b5cf6"]);
  expect(purpleColors({ "--color-x": "var(--color-y)", "--color-y": "#a0f" })).toHaveLength(2);
  expect(purpleColors({ "--color-gray": "#808080" })).toEqual([]);
});

test("no WhatsApp green", () => {
  expect(whatsappGreen(sources)).toEqual([]);
  expect(whatsappGreen(planted("fill: #25D366"))).toHaveLength(1);
});

test("only the primary button variant paints bg-action", () => {
  expect(actionBackground(sources)).toEqual([]);
  const variants = (body: string) => planted(body, actionVariantsPath);
  expect(actionBackground(planted('<a className="bg-action">'))).toHaveLength(1);
  expect(actionBackground(planted('<a className="hover:bg-action/50">'))).toHaveLength(1);
  expect(actionBackground(planted('<a className="bg-action-hover bg-action-soft">'))).toEqual([]);
  expect(
    actionBackground(variants('{ primary: "bg-action", secondary: "bg-action-soft" }')),
  ).toEqual([]);
  expect(actionBackground(variants('{ primary: "x", secondary: "bg-action" }'))).toHaveLength(1);
  expect(actionBackground(variants('{ primary: "bg-action bg-action" }'))).toHaveLength(1);
});

test("no color gradients", () => {
  expect(gradients(sources)).toEqual([]);
  expect(gradients(planted('<div className="bg-linear-to-r">'))).toHaveLength(1);
  expect(gradients(planted('<div className="bg-gradient-to-b">'))).toHaveLength(1);
  expect(gradients(planted("a{background:linear-gradient(red, blue)}", "src/x.css"))).toHaveLength(
    1,
  );
  expect(gradients(planted("a{background:radial-gradient(red, blue)}", "src/x.css"))).toHaveLength(
    1,
  );
  expect(gradients(planted("a{mask:linear-gradient(transparent, black)}", "src/x.css"))).toEqual(
    [],
  );
  expect(
    gradients(planted("a{background:linear-gradient(red, blue)}", "src/styles/marks.css")),
  ).toEqual([]);
});

test("no dangerouslySetInnerHTML", () => {
  expect(innerHtml(sources)).toEqual([]);
  expect(innerHtml(planted("<div dangerouslySetInnerHTML={{ __html: x }} />"))).toHaveLength(1);
});

test("fixed copy never asks for human contact", () => {
  const values = (tree: unknown): string[] =>
    typeof tree === "string"
      ? [tree]
      : tree && typeof tree === "object"
        ? Object.values(tree).flatMap(values)
        : [];
  expect(humanContact(values(copy))).toEqual([]);
  expect(humanContact(values({ a: { b: "Agenda una llamada" } }))).toHaveLength(1);
  expect(humanContact(["Pide una demo", "Reunión", "Escríbenos por WhatsApp"])).toHaveLength(3);
  expect(humanContact(["Pide tu informe"])).toEqual([]);
});
