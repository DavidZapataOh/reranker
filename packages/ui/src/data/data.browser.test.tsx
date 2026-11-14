import type { EngineStatus, LevelKey, ScoreEstimate } from "@reranker/schema/measurement";
import { afterEach, expect, test } from "vitest";
import { page } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";
import { expectNoAxeViolations } from "../../test/axe.ts";
import { DotSample } from "./DotSample.tsx";
import { ScoreNumber } from "./ScoreNumber.tsx";
import { ScoreRule } from "./ScoreRule.tsx";
import { StatusBadge } from "./StatusBadge.tsx";

afterEach(cleanup);

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
const est = (over: Partial<ScoreEstimate>): ScoreEstimate => ({
  value: 55,
  lower: 48,
  upper: 62,
  atMost: null,
  level: "on_the_list",
  levelDisplay: { kind: "single", level: "on_the_list" },
  sufficiency: "sufficient",
  preliminary: true,
  components: {
    recommendationRate: {
      estimate: 0.5,
      lower: 0.4,
      upper: 0.6,
      successes: 15,
      trials: 30,
      effectiveTrials: 28,
      designEffect: 1.07,
      method: "jeffreys_eff",
    },
    prominence: { estimate: 0.5, lower: 0.4, upper: 0.6, typicalPosition: 3 },
  },
  ...over,
});

const scores = {
  single: est({}),
  between: est({
    value: 42,
    lower: 38,
    upper: 46,
    levelDisplay: { kind: "between", from: "sometimes", to: "on_the_list" },
  }),
  insufficient: est({ value: 30, lower: 5, upper: 45, levelDisplay: { kind: "insufficient" } }),
  atMost: est({
    value: 0,
    lower: 0,
    upper: 7,
    atMost: 7,
    levelDisplay: { kind: "single", level: "invisible" },
  }),
  point: est({ value: 100, lower: 100, upper: 100 }),
};

const surfaces = ["bg-surface", "bg-paper"] as const;

test("every score state, sample and status passes axe on white and on paper", async () => {
  await render(
    <div>
      {surfaces.map((surface) => (
        <div key={surface} className={`${surface} flex flex-col gap-8 p-6 text-ink`}>
          {Object.entries(scores).map(([name, s]) => (
            <div key={name} className="flex flex-col gap-4">
              <ScoreNumber score={s} />
              <ScoreRule score={s} levelLabels={L} />
            </div>
          ))}
          <DotSample filled={0} total={5} />
          <DotSample filled={5} total={5} label="respuestas" />
          <DotSample filled={7} total={12} />
          {(Object.keys(W) as EngineStatus[]).map((status) => (
            <StatusBadge key={status} status={status} words={W} />
          ))}
        </div>
      ))}
    </div>,
  );
  expect(document.querySelectorAll("figure")).toHaveLength(10);
  await expectNoAxeViolations(document.body);
});

test("the figure is announced by its sentence, with the level part visible", async () => {
  await render(<ScoreRule score={scores.between} levelLabels={L} />);
  await expect
    .element(
      page.getByRole("figure", { name: "Puntaje 42, entre 38 y 46: entre A veces y En la lista" }),
    )
    .toBeVisible();
  await expect.element(page.getByText("Entre A veces y En la lista")).toBeVisible();
});

for (const width of [320, 640, 1024]) {
  test(`at ${width} px the level names never overlap and a one-point bracket is still drawn`, async () => {
    await page.viewport(width, 640);
    const { container } = await render(
      <div className="flex flex-col gap-8 px-5">
        <ScoreRule score={scores.between} levelLabels={L} />
        <ScoreRule score={scores.point} levelLabels={L} />
      </div>,
    );
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
    for (const figure of container.querySelectorAll("figure")) {
      const frame = figure.getBoundingClientRect();
      const names = [...figure.querySelectorAll("[data-level-name]")].map((el) =>
        el.getBoundingClientRect(),
      );
      expect(names).toHaveLength(4);
      for (const [i, r] of names.entries()) {
        expect(r.left).toBeGreaterThanOrEqual(frame.left);
        expect(r.right).toBeLessThanOrEqual(frame.right);
        // On a phone the row may wrap; names on the same line keep a gap, never overlap.
        for (const other of names.slice(i + 1)) {
          const sameLine = r.top < other.bottom && other.top < r.bottom;
          if (sameLine) expect(r.right).toBeLessThanOrEqual(other.left - 4);
        }
      }
    }
    const bracket = container.querySelectorAll('[data-part="range"]')[1] as SVGRectElement;
    const box = bracket.getBoundingClientRect();
    const frame = (container.querySelectorAll("figure")[1] as HTMLElement).getBoundingClientRect();
    expect(box.width).toBeGreaterThanOrEqual(2);
    expect(box.right).toBeLessThanOrEqual(frame.right + 1);
  });
}

test("the sometimes badge keeps amber as a shape behind an ink border, never as text", async () => {
  const { container } = await render(<StatusBadge status="sometimes" words={W} />);
  const word = container.firstElementChild as HTMLElement;
  expect(getComputedStyle(word).color).not.toBe("rgb(242, 181, 68)");
  const amber = container.querySelector(".bg-amber") as HTMLElement;
  expect(getComputedStyle(amber).backgroundColor).toBe("rgb(242, 181, 68)");
  const half = amber.getBoundingClientRect();
  const ring = (container.querySelector("svg circle") as SVGCircleElement).getBoundingClientRect();
  // The amber half sits inside the ink ring, on its right side.
  expect(half.left).toBeGreaterThanOrEqual(ring.left + ring.width / 2 - 0.5);
  expect(half.right).toBeLessThanOrEqual(ring.right);
  expect(half.top).toBeGreaterThanOrEqual(ring.top);
  expect(half.bottom).toBeLessThanOrEqual(ring.bottom);
  expect(getComputedStyle(container.querySelector("svg circle") as Element).stroke).toBe(
    "rgb(20, 33, 27)",
  );
});
