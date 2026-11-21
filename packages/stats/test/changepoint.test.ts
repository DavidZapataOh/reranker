import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  type BocpdState,
  bocpdInit,
  bocpdStep,
  cusumBaseline,
  cusumStep,
  empiricalLogit,
  hFor,
  regimeAlarm,
} from "../src/changepoint";
import { rngFromSeed } from "../src/rng";

const vectors = (name: string) =>
  JSON.parse(readFileSync(new URL(`../test-vectors/changepoint/${name}`, import.meta.url), "utf8"))
    .cases;

type CusumCase = {
  input: { baselineYs: number[]; n: number; p: number; h: number; ys: number[] };
  output: {
    mu0: number;
    sigma: number;
    steps: Array<{ up: number; down: number; alarm: boolean }>;
  };
};
type BocpdCase = {
  input: { ys: number[]; ns: number[] };
  output: { mapRunLengths: number[]; finalLogR: number[] };
};

const cusumVectors: CusumCase[] = vectors("cusum.json");
const bocpdVectors: BocpdCase[] = vectors("bocpd.json");

function runBocpd(ys: readonly number[], ns: readonly number[]) {
  let state: BocpdState = bocpdInit();
  const maps: number[] = [];
  ys.forEach((y, t) => {
    const step = bocpdStep(state, y, ns[t] as number);
    state = step.state;
    maps.push(step.mapRunLength);
  });
  return { state, maps };
}

describe("CUSUM", () => {
  test("h matches the audit simulation", () => {
    expect(hFor(0.2)).toBeCloseTo(2.84, 1);
    expect(hFor(0.5)).toBeCloseTo(3.52, 1);
  });

  test("h interpolates between calibrated rates and holds at the ends", () => {
    expect(hFor(0.225)).toBeCloseTo((hFor(0.2) + hFor(0.25)) / 2, 10);
    expect(hFor(0)).toBe(hFor(0.05));
    expect(hFor(1)).toBe(hFor(0.95));
    expect(() => hFor(1.2)).toThrow(RangeError);
  });

  test("the empirical logit is finite at both ends and refuses impossible counts", () => {
    expect(empiricalLogit(0, 10)).toBeCloseTo(Math.log(0.5 / 10.5), 12);
    expect(empiricalLogit(10, 10)).toBeCloseTo(-empiricalLogit(0, 10), 12);
    expect(() => empiricalLogit(11, 10)).toThrow(RangeError);
    expect(() => empiricalLogit(1.5, 10)).toThrow(RangeError);
  });

  test.each(cusumVectors)("vector %#", ({ input, output }) => {
    const baseline = cusumBaseline(
      input.baselineYs.map((y) => empiricalLogit(y, input.n)),
      input.p,
    );
    expect(baseline?.mu0).toBeCloseTo(output.mu0, 12);
    expect(baseline?.sigma).toBeCloseTo(output.sigma, 12);
    if (!baseline) throw new Error("the vector baseline varies");
    // The reference fixes h from the audit; the chart itself is what is compared.
    const b = { ...baseline, h: input.h };
    let s = { up: 0, down: 0 };
    input.ys.forEach((y, t) => {
      const step = cusumStep(s, empiricalLogit(y, input.n), b);
      const want = output.steps[t];
      expect(step.up).toBeCloseTo(want?.up as number, 10);
      expect(step.down).toBeCloseTo(want?.down as number, 10);
      expect(step.alarm).toBe(want?.alarm);
      s = step;
    });
  });

  test("a prompt without baseline variation has no baseline and never alarms", () => {
    expect(cusumBaseline(Array(42).fill(-3.04), 0)).toBeNull();
    expect(() => cusumBaseline([1], 0.2)).toThrow(RangeError);
  });
});

describe("BOCPD", () => {
  test.each(bocpdVectors)("vector %#", ({ input, output }) => {
    const { state, maps } = runBocpd(input.ys, input.ns);
    expect(maps).toEqual(output.mapRunLengths);
    expect(state.logR).toHaveLength(output.finalLogR.length);
    state.logR.forEach((v, r) => {
      expect(v).toBeCloseTo(output.finalLogR[r] as number, 8);
    });
  });

  test("run length drops to a recent changepoint after a shift", () => {
    const rng = rngFromSeed("a".repeat(64));
    const binomial = (p: number) => Array.from({ length: 10 }).filter(() => rng.next() < p).length;
    const ys = [...Array.from({ length: 60 }, () => binomial(0.2))];
    ys.push(...Array.from({ length: 10 }, () => binomial(0.6)));
    const { maps } = runBocpd(ys, Array(ys.length).fill(10));
    expect(maps[59]).toBeGreaterThan(40);
    expect(maps[69]).toBeLessThanOrEqual(12);
  });

  test("a long stable series stays at the last run length instead of resetting", () => {
    const { state, maps } = runBocpd(Array(450).fill(5), Array(450).fill(10));
    expect(maps.at(-1)).toBe(400);
    expect(state.logR).toHaveLength(401);
  });

  test("the posterior stays normalized and refuses impossible counts", () => {
    const { state } = runBocpd([1, 2, 9, 0, 10, 3], [10, 10, 10, 10, 10, 7]);
    const total = state.logR.reduce((sum, v) => sum + Math.exp(v), 0);
    expect(total).toBeCloseTo(1, 12);
    expect(() => bocpdStep(bocpdInit(), 4, 3)).toThrow(RangeError);
    expect(() => bocpdInit({ a: 0, b: 1 })).toThrow(RangeError);
  });
});

describe("regime rule", () => {
  test("the regime rule ignores prompts without baseline in its denominator", () =>
    expect(regimeAlarm([true, true, false, false, false, false])).toBe(true));

  test("fewer than 30% alarming, or no prompt with a baseline, opens nothing", () => {
    expect(regimeAlarm([true, false, false, false])).toBe(false);
    expect(regimeAlarm([])).toBe(false);
    expect(regimeAlarm([true, false], 0.6)).toBe(false);
  });
});
