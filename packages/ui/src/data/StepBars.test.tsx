import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { tokens } from "../tokens.ts";
import { StepBars } from "./StepBars.tsx";

const labels = ["Invisible", "A veces", "En la lista", "De los fijos"] as const;
const html = (current: 0 | 1 | 2 | 3) =>
  renderToStaticMarkup(<StepBars current={current} labels={labels} />);
const bars = (out: string) => [...out.matchAll(/<span class="relative[^"]*" style="([^"]*)">/g)];

test("draws one rising bar per level", () => {
  const out = html(2);
  expect(bars(out).map((m) => Number(/height:(\d+)px/.exec(m[1] ?? "")?.[1]))).toEqual([
    18, 34, 50, 66,
  ]);
  for (const label of labels) expect(out).toContain(`>${label}</span>`);
});

test("fills the bars up to the current level", () => {
  const filled = (out: string) =>
    bars(out).map((m) => (m[1] ?? "").includes(`background-color:${tokens.color.green}`));
  expect(filled(html(2))).toEqual([true, true, true, false]);
  expect(filled(html(0))).toEqual([true, false, false, false]);
  for (const m of bars(html(0)).slice(1)) {
    expect(m[1]).toContain(`background-color:${tokens.color.greenLight}`);
  }
});

test("marks only the current level with the amber dot and a bold label", () => {
  const out = html(1);
  expect(out.match(/bg-amber/g)).toHaveLength(1);
  expect(out).toMatch(/height:34px[^"]*"><span class="[^"]*bg-amber/);
  expect(out).toContain('font-semibold text-ink">A veces<');
  expect(out.match(/font-semibold/g)).toHaveLength(1);
});

test("staggers the fill from the level below the start", () => {
  expect(bars(html(1)).map((m) => /transition-delay:(-?\d+)ms/.exec(m[1] ?? "")?.[1])).toEqual([
    "-150",
    "0",
    "150",
    "300",
  ]);
});

test("is decorative: the score is announced elsewhere", () => {
  expect(html(3)).toMatch(/^<div class="[^"]*" aria-hidden="true">/);
});
