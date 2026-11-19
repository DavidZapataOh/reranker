import type { RateEstimate } from "@reranker/schema/measurement";
import fc from "fast-check";
import { describe, expect, test } from "vitest";
import {
  clusterDeff,
  effectiveSize,
  jeffreys,
  normalQuantile,
  wilson,
  wilsonDivergence,
} from "../src/interval";
import vectors from "../test-vectors/intervals.json" with { type: "json" };

type Stratum = { weight: number; successes: number; trials: number };

function equalStrata(trials: number, successes: number[]): Stratum[] {
  return successes.map((y) => ({ weight: 1, successes: y, trials }));
}

function rate(overrides: Partial<RateEstimate>): RateEstimate {
  return {
    estimate: 0.1,
    lower: 0,
    upper: 1,
    successes: 12,
    trials: 120,
    effectiveTrials: 120,
    designEffect: 1,
    method: "jeffreys_eff",
    ...overrides,
  };
}

describe("jeffreys", () => {
  test.each(vectors.jeffreys)(
    "jeffreys($y, $n) at $level matches scipy to 1e-6",
    ({ y, n, level, lower, upper }) => {
      const r = jeffreys(y, n, level);
      expect(r.lower).toBeCloseTo(y === 0 ? 0 : lower, 6);
      expect(r.upper).toBeCloseTo(y === n ? 1 : upper, 6);
    },
  );

  test("the spec anchors", () => {
    expect(jeffreys(0, 120)).toEqual({ lower: 0, upper: expect.closeTo(0.0206726, 6) });
    expect(jeffreys(12, 120).lower).toBeCloseTo(0.0558395, 6);
    expect(jeffreys(12, 120).upper).toBeCloseTo(0.1631456, 6);
    expect(jeffreys(0, 40).upper).toBeCloseTo(0.060498, 6);
    expect(jeffreys(0, 200).upper).toBeCloseTo(0.0124657, 6);
  });

  test("defaults to the methodology level", () => {
    expect(jeffreys(5, 40)).toEqual(jeffreys(5, 40, 0.95));
  });

  test("y = n has an upper bound of exactly 1", () => {
    expect(jeffreys(40, 40).upper).toBe(1);
  });

  // Within 1e-3 of either end the raw quantile can pass a vanishing p̂ (or 1 − p̂); effective
  // counts are either exact boundaries or far from them.
  test("the interval is ordered, inside [0, 1] and contains the proportion", () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0.5, max: 500, noNaN: true }),
        fc.oneof(fc.constant(0), fc.constant(1), fc.double({ min: 0, max: 1, noNaN: true })),
        (n, share) => {
          const y = share === 0 || share === 1 ? share * n : 0.001 + share * (n - 0.002);
          const r = jeffreys(y, n);
          return 0 <= r.lower && r.lower <= y / n && y / n <= r.upper && r.upper <= 1;
        },
      ),
    );
  });

  test.each([
    [-1, 10],
    [11, 10],
    [0, 0],
    [Number.NaN, 10],
    [1, Number.POSITIVE_INFINITY],
  ])("rejects successes %s of trials %s", (y, n) => {
    expect(() => jeffreys(y, n)).toThrow(RangeError);
  });

  test.each([0, 1, -0.5, Number.NaN])("rejects level %s", (level) => {
    expect(() => jeffreys(1, 10, level)).toThrow(RangeError);
  });
});

describe("wilson", () => {
  test.each(vectors.wilson)(
    "wilson($y, $n) at $level matches statsmodels to 1e-6",
    ({ y, n, level, lower, upper }) => {
      const r = wilson(y, n, level);
      expect(r.lower).toBeCloseTo(lower, 6);
      expect(r.upper).toBeCloseTo(upper, 6);
    },
  );

  test("the spec anchor", () => {
    expect(wilson(12, 120).lower).toBeCloseTo(0.058133592, 6);
    expect(wilson(12, 120).upper).toBeCloseTo(0.1666817411, 6);
  });

  test("the bounds at y = 0 and y = n are exactly 0 and 1", () => {
    expect(wilson(0, 200).lower).toBe(0);
    expect(wilson(200, 200).upper).toBe(1);
  });

  test("rejects invalid counts", () => {
    expect(() => wilson(3, 2)).toThrow(RangeError);
  });
});

describe("normalQuantile", () => {
  test.each(vectors.normalQuantile)("Φ⁻¹($p) matches scipy", ({ p, z }) => {
    expect(normalQuantile(p)).toBeCloseTo(z, 12);
  });

  test("is antisymmetric around 0.5", () => {
    fc.assert(
      fc.property(fc.double({ min: 1e-6, max: 0.5, noNaN: true }), (p) => {
        return Math.abs(normalQuantile(p) + normalQuantile(1 - p)) < 1e-9;
      }),
    );
  });

  test.each([0, 1, Number.NaN])("rejects p = %s", (p) => {
    expect(() => normalQuantile(p)).toThrow(RangeError);
  });
});

describe("effectiveSize", () => {
  test("effective size: equal weights and n give n_eff = n_total", () => {
    expect(effectiveSize(equalStrata(40, [3, 2, 0, 1, 2])).nEff).toBe(200);
  });

  test("a self-weighting design is exactly the pooled proportion", () => {
    const strata = [
      { weight: 3, successes: 2, trials: 30 },
      { weight: 1, successes: 5, trials: 10 },
    ];
    expect(effectiveSize(strata)).toMatchObject({ estimate: 7 / 40, nEff: 40, nKish: 40 });
  });

  test("p̂ in {0, 1} uses the Kish size", () => {
    const zeroStrata = equalStrata(8, [0, 0, 0, 0, 0]);
    expect(effectiveSize(zeroStrata).nEff).toBe(zeroStrata.reduce((s, x) => s + x.trials, 0));
    const allStrata = equalStrata(8, [8, 8, 8]);
    expect(effectiveSize(allStrata)).toMatchObject({ estimate: 1, nEff: 24, variance: 0 });
  });

  test("unequal weights: p̂, v̂ and n_Kish follow the stratified formulas", () => {
    const strata = [
      { weight: 0.75, successes: 4, trials: 10 },
      { weight: 0.25, successes: 1, trials: 30 },
    ];
    const p = 0.75 * 0.4 + 0.25 * (1 / 30);
    const v = (0.75 ** 2 * 0.4 * 0.6) / 10 + (0.25 ** 2 * (1 / 30) * (29 / 30)) / 30;
    const kish = 1 / (0.75 ** 2 / 10 + 0.25 ** 2 / 30);
    const r = effectiveSize(strata);
    expect(r.estimate).toBeCloseTo(p, 12);
    expect(r.variance).toBeCloseTo(v, 12);
    expect(r.nKish).toBeCloseTo(kish, 10);
    expect(r.nEff).toBeCloseTo(Math.min((p * (1 - p)) / v, kish), 10);
  });

  test("unequal weights with p̂ = 0 fall back to n_Kish", () => {
    const r = effectiveSize([
      { weight: 0.9, successes: 0, trials: 10 },
      { weight: 0.1, successes: 0, trials: 30 },
    ]);
    expect(r.nEff).toBe(r.nKish);
    expect(r.nKish).toBeCloseTo(1 / (0.81 / 10 + 0.01 / 30), 10);
  });

  test("v̂ = 0 with 0 < p̂ < 1 falls back to n_Kish", () => {
    const r = effectiveSize([
      { weight: 0.7, successes: 10, trials: 10 },
      { weight: 0.3, successes: 0, trials: 20 },
    ]);
    expect(r.variance).toBe(0);
    expect(r.estimate).toBeCloseTo(0.7, 12);
    expect(r.nEff).toBe(r.nKish);
  });

  test("weights that do not add to 1 are normalized", () => {
    const strata = (w: number[]) =>
      w.map((weight, i) => ({ weight, successes: i + 1, trials: 10 + 5 * i }));
    const a = effectiveSize(strata([2, 6, 2]));
    const b = effectiveSize(strata([0.2, 0.6, 0.2]));
    expect(a.estimate).toBeCloseTo(b.estimate, 12);
    expect(a.nEff).toBeCloseTo(b.nEff, 10);
  });

  test("n_eff never exceeds n_Kish nor the total trials", () => {
    const stratum = fc.record({
      weight: fc.double({ min: 0.01, max: 10, noNaN: true }),
      trials: fc.integer({ min: 1, max: 40 }),
      share: fc.double({ min: 0, max: 1, noNaN: true }),
    });
    fc.assert(
      fc.property(fc.array(stratum, { minLength: 1, maxLength: 25 }), (raw) => {
        const strata = raw.map(({ weight, trials, share }) => ({
          weight,
          trials,
          successes: Math.round(share * trials),
        }));
        const r = effectiveSize(strata);
        const total = strata.reduce((s, x) => s + x.trials, 0);
        return (
          r.nEff > 0 &&
          r.nEff <= r.nKish * (1 + 1e-12) &&
          r.nKish <= total * (1 + 1e-12) &&
          r.estimate >= 0 &&
          r.estimate <= 1
        );
      }),
    );
  });

  test.each<[string, Stratum[]]>([
    ["no strata", []],
    ["zero trials", [{ weight: 1, successes: 0, trials: 0 }]],
    ["more successes than trials", [{ weight: 1, successes: 3, trials: 2 }]],
    ["a negative weight", [{ weight: -1, successes: 1, trials: 2 }]],
    ["zero total weight", [{ weight: 0, successes: 1, trials: 2 }]],
    ["a non-finite weight", [{ weight: Number.POSITIVE_INFINITY, successes: 1, trials: 2 }]],
  ])("rejects %s", (_, strata) => {
    expect(() => effectiveSize(strata)).toThrow(RangeError);
  });
});

describe("clusterDeff", () => {
  test("clusterDeff(10, 0.26) = 3.34", () => expect(clusterDeff(10, 0.26)).toBeCloseTo(3.34, 10));

  test("one run per variant has no design effect", () => expect(clusterDeff(1, 0.26)).toBe(1));

  test.each([
    [0, 0.26],
    [2, -0.1],
    [2, 1.1],
    [Number.NaN, 0.2],
  ])("rejects runs %s with rho %s", (runs, rho) => {
    expect(() => clusterDeff(runs, rho)).toThrow(RangeError);
  });
});

describe("wilsonDivergence", () => {
  test("is the largest bound gap in points against Wilson on (y*, n_eff)", () => {
    const j = jeffreys(12, 120);
    const w = wilson(12, 120);
    const expected = 100 * Math.max(Math.abs(j.lower - w.lower), Math.abs(j.upper - w.upper));
    expect(wilsonDivergence(rate({ ...j }))).toBeCloseTo(expected, 12);
  });

  test("uses the effective size, not the raw trials", () => {
    const j = jeffreys(0.1 * 37.6, 37.6);
    const w = wilson(0.1 * 37.6, 37.6);
    const expected = 100 * Math.max(Math.abs(j.lower - w.lower), Math.abs(j.upper - w.upper));
    expect(wilsonDivergence(rate({ ...j, effectiveTrials: 37.6, trials: 120 }))).toBeCloseTo(
      expected,
      12,
    );
  });

  test("with zero successes Jeffreys and Wilson differ by about 1 point at n = 120", () => {
    const d = wilsonDivergence(rate({ ...jeffreys(0, 120), estimate: 0, successes: 0 }));
    expect(d).toBeCloseTo(100 * (0.031019166418703486 - 0.02067255048157903), 6);
  });
});
