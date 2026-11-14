import type { EngineStatus, LevelKey, ScoreEstimate } from "@reranker/schema/measurement";
import fc from "fast-check";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { DotSample } from "./DotSample.tsx";
import { ScoreNumber } from "./ScoreNumber.tsx";
import { ScoreRule } from "./ScoreRule.tsx";
import { StatusBadge } from "./StatusBadge.tsx";
import { LEVEL_CUTS, LEVEL_ORDER, rangeGeometry, scoreSentence } from "./scale.ts";

const L: Record<LevelKey, string> = {
  invisible: "Invisible",
  sometimes: "A veces",
  on_the_list: "En la lista",
  regular: "De los fijos",
};
const W: Record<EngineStatus, string> = {
  regular: "De los fijos",
  on_the_list: "En la lista",
  sometimes: "A veces",
  invisible: "Invisible",
  few_data: "Pocos datos",
};

const rate = {
  estimate: 0.4,
  lower: 0.3,
  upper: 0.5,
  successes: 12,
  trials: 30,
  effectiveTrials: 28,
  designEffect: 1.07,
  method: "jeffreys_eff",
} as const;
const est = (over: Partial<ScoreEstimate>): ScoreEstimate => ({
  value: 42,
  lower: 38,
  upper: 46,
  atMost: null,
  level: "sometimes",
  levelDisplay: { kind: "single", level: "on_the_list" },
  sufficiency: "sufficient",
  preliminary: false,
  components: {
    recommendationRate: rate,
    prominence: { estimate: 0.5, lower: 0.4, upper: 0.6, typicalPosition: 3 },
  },
  ...over,
});

const html = (el: ReactElement) => renderToStaticMarkup(el);
const rule = (s: ScoreEstimate) => html(<ScoreRule score={s} levelLabels={L} />);
const textOf = (markup: string) =>
  markup
    .replace(/<!-- -->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
const count = (markup: string, needle: string) => markup.split(needle).length - 1;
const attr = (tag: string, name: string) => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];
const range = (markup: string) => {
  const tag = /<rect[^>]*data-part="range"[^>]*>/.exec(markup)?.[0] ?? "";
  return { x: Number(attr(tag, "x")), width: Number(attr(tag, "width")) };
};
const figureLabel = (s: ScoreEstimate) =>
  attr(/<figure[^>]*>/.exec(rule(s))?.[0] ?? "", "aria-label");
const caption = (s: ScoreEstimate) =>
  textOf(/<figcaption[^>]*>([\s\S]*?)<\/figcaption>/.exec(rule(s))?.[1] ?? "");
const active = (s: ScoreEstimate) =>
  [...rule(s).matchAll(/<rect[^>]*>/g)]
    .filter((m) => attr(m[0], "data-active") === "true")
    .map((m) => attr(m[0], "data-level"));

const s1 = est({
  value: 42,
  lower: 38,
  upper: 46,
  levelDisplay: { kind: "between", from: "sometimes", to: "on_the_list" },
});
const s2 = est({
  value: 55,
  lower: 48,
  upper: 62,
  levelDisplay: { kind: "single", level: "on_the_list" },
});
const s3 = est({
  value: 8,
  lower: 3,
  upper: 15,
  levelDisplay: { kind: "between", from: "invisible", to: "sometimes" },
});
const s4 = est({ value: 30, lower: 5, upper: 45, levelDisplay: { kind: "insufficient" } });
const s5 = est({
  value: 0,
  lower: 0,
  upper: 7,
  atMost: 7,
  levelDisplay: { kind: "single", level: "invisible" },
});

test("the scale draws the level cuts in reading order", () => {
  expect(LEVEL_CUTS).toEqual([10, 40, 70]);
  expect(LEVEL_ORDER).toEqual(["invisible", "sometimes", "on_the_list", "regular"]);
});

test("the rule brackets the range and names the levels it is given", () => {
  expect(range(rule(s1))).toEqual({ x: 38, width: 8 });
  expect(figureLabel(s1)).toBe("Puntaje 42, entre 38 y 46: entre A veces y En la lista");
  expect(active(s1)).toEqual(["sometimes", "on_the_list"]);
  expect(caption(s1)).toBe("Entre A veces y En la lista");

  expect(caption(s2)).toBe("En la lista");
  expect(active(s2)).toEqual(["on_the_list"]);
  expect(figureLabel(s3)).toBe("Puntaje 8, entre 3 y 15: entre Invisible y A veces");
  expect(caption(s4)).toBe("Pocos datos para darte un nivel");
  expect(figureLabel(s4)).toBe("Puntaje 30, entre 5 y 45: pocos datos para darte un nivel");
  expect(active(s4)).toEqual([]);
});

test("the levels come from levelDisplay, never from the value", () => {
  // 42 sits inside "A veces" by the cuts, yet the rule must show what the statistics decided.
  const s = est({ value: 42, levelDisplay: { kind: "single", level: "regular" } });
  expect(caption(s)).toBe("De los fijos");
  expect(active(s)).toEqual(["regular"]);
  const wide = est({ levelDisplay: { kind: "between", from: "invisible", to: "on_the_list" } });
  expect(active(wide)).toEqual(["invisible", "sometimes", "on_the_list"]);
});

test("the four bands sit on the cuts, with the level names below in HTML", () => {
  const bands = [...rule(s2).matchAll(/<rect[^>]*data-level="[^"]*"[^>]*>/g)].map((m) => ({
    level: attr(m[0], "data-level"),
    x: Number(attr(m[0], "x")),
    width: Number(attr(m[0], "width")),
  }));
  expect(bands).toEqual([
    { level: "invisible", x: 0, width: 10 },
    { level: "sometimes", x: 10, width: 30 },
    { level: "on_the_list", x: 40, width: 30 },
    { level: "regular", x: 70, width: 30 },
  ]);
  const out = rule(s2);
  expect(out).toMatch(/<svg[^>]*viewBox="0 0 100 24"[^>]*aria-hidden="true"/);
  for (const label of Object.values(L)) expect(out).toMatch(new RegExp(`>${label}</span>`));
});

test("edge scores: a lo sumo, a single point and the top of the scale stay visible", () => {
  expect(figureLabel(s5)).toBe("Puntaje 0, a lo sumo 7: Invisible");
  expect(html(<ScoreNumber score={s5} />)).toContain("a lo sumo 7");
  expect(range(rule(s5))).toEqual({ x: 0, width: 7 });
  expect(range(rule(est({ value: 50, lower: 50, upper: 50 })))).toEqual({ x: 50, width: 1 });
  expect(range(rule(est({ value: 100, lower: 100, upper: 100 })))).toEqual({ x: 99, width: 1 });
  expect(range(rule(est({ value: 0, lower: 0, upper: 0, atMost: 0 })))).toEqual({
    x: 0,
    width: 1,
  });
  expect(rule(est({ value: 100, lower: 92, upper: 100 }))).not.toContain("NaN");
  expect(rule(s1)).not.toMatch(/needle|<circle/);
});

test("the bracket is always inside the scale, at least one unit wide, and covers the range", () => {
  // Edge-heavy: equal bounds and the ends of the scale are where a bracket disappears or overflows.
  const start = fc.oneof(fc.constantFrom(0, 1, 99, 100), fc.integer({ min: 0, max: 100 }));
  const spread = fc.oneof(fc.constantFrom(0, 1), fc.integer({ min: 0, max: 100 }));
  fc.assert(
    fc.property(start, spread, (a, d) => {
      const lower = Math.min(a, 100 - d);
      const upper = lower + d;
      const { x, width } = rangeGeometry(lower, upper);
      expect(width).toBeGreaterThanOrEqual(1);
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x + width).toBeLessThanOrEqual(100);
      expect(x).toBeLessThanOrEqual(lower);
      expect(x + width).toBeGreaterThanOrEqual(upper);
      if (upper - lower >= 1) expect({ x, width }).toEqual({ x: lower, width: upper - lower });
    }),
  );
});

test("a score outside the scale or not a number fails loudly instead of drawing NaN", () => {
  for (const bad of [
    { lower: Number.NaN },
    { upper: Number.POSITIVE_INFINITY },
    { lower: -1 },
    { upper: 101 },
    { lower: 50, upper: 40 },
    { value: Number.NaN },
    { atMost: Number.NaN },
  ]) {
    expect(() => rule(est(bad))).toThrow(RangeError);
    expect(() => scoreSentence(est(bad), L)).toThrow(RangeError);
  }
});

test("the number is the display numeral with its range in mono and the preliminary note", () => {
  const out = html(<ScoreNumber score={s1} />);
  expect(out).toMatch(/class="[^"]*font-display[^"]*tabular-nums[^"]*">/);
  expect(out).toMatch(/class="[^"]*font-mono[^"]*text-\[13px\][^"]*">entre 38 y 46</);
  expect(textOf(out)).toBe("Puntaje 42 entre 38 y 46");
  expect(out).not.toContain("preliminar");
  expect(html(<ScoreNumber score={{ ...s1, preliminary: true }} />)).toContain("preliminar");
});

test("dot samples draw up to ten dots and switch to words above that", () => {
  const d = html(<DotSample filled={0} total={5} />);
  expect(count(d, "<circle")).toBe(5);
  expect(count(d, 'data-filled="true"')).toBe(0);
  expect(textOf(d)).toBe("0 de 5");
  expect(d).toMatch(/<svg[^>]*aria-hidden="true"/);

  const full = html(<DotSample filled={5} total={5} />);
  expect(count(full, 'data-filled="true"')).toBe(5);
  expect(
    full.match(/<circle[^>]*data-filled="true"[^>]*>/g)?.every((c) => c.includes("fill-green")),
  ).toBe(true);

  const many = html(<DotSample filled={7} total={12} />);
  expect(textOf(many)).toBe("en 7 de 12");
  expect(count(many, "<circle")).toBe(0);
  expect(count(html(<DotSample filled={3} total={10} />), "<circle")).toBe(10);

  expect(textOf(html(<DotSample filled={3} total={5} label="respuestas" />))).toBe(
    "3 de 5 respuestas",
  );
  expect(textOf(html(<DotSample filled={7} total={12} label="respuestas" />))).toBe(
    "en 7 de 12 respuestas",
  );
});

test("dot samples reject counts that are not a sample", () => {
  for (const [f, t] of [
    [6, 5],
    [-1, 5],
    [1.5, 5],
    [0, 0],
    [1, 2.5],
    [Number.NaN, 5],
  ] as const) {
    expect(() => html(<DotSample filled={f} total={t} />)).toThrow(RangeError);
  }
});

test("every engine status is a decorative shape plus its visible word", () => {
  for (const status of ["regular", "on_the_list", "sometimes", "invisible", "few_data"] as const) {
    const out = html(<StatusBadge status={status} words={W} />);
    expect(textOf(out)).toBe(W[status]);
    expect(out).toMatch(/<svg[^>]*aria-hidden="true"/);
  }
  expect(html(<StatusBadge status="regular" words={W} />)).toContain("text-green");
  // Amber is a highlighter surface behind the ink outline, never an SVG fill (the brand rule treats fills as text).
  const sometimes = html(<StatusBadge status="sometimes" words={W} />);
  expect(sometimes).toMatch(
    /<span class="[^"]*bg-amber[^"]*" aria-hidden="true"><\/span><svg[^>]*aria-hidden="true"/,
  );
  expect(sometimes).toContain("stroke-ink");
  expect(sometimes).not.toMatch(/(?:fill|stroke|text)-amber/);
  expect(html(<StatusBadge status="few_data" words={W} />)).toContain("stroke-dasharray");
});

test("a status without its word fails instead of rendering a bare shape", () => {
  expect(() => html(<StatusBadge status="regular" words={{ ...W, regular: "" }} />)).toThrow();
  expect(() => html(<StatusBadge status="few_data" words={{ ...W, few_data: "  " }} />)).toThrow();
  // @ts-expect-error words is required
  const missing = () => <StatusBadge status="regular" />;
  expect(missing).toBeTypeOf("function");
});
