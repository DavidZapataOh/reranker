import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { jeffreys } from "../src/interval";
import { estimateRate, type StratumCounts } from "../src/rate";

const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0);

function withWeights(weights: readonly number[]): StratumCounts[] {
  const counts = [
    [3, 8],
    [1, 8],
    [6, 16],
  ] as const;
  return weights.map((weight, i) => {
    const [successes, trials] = counts[i % counts.length] as readonly [number, number];
    return { stratum: `s${i}`, weight, successes, trials };
  });
}

// Five engines with unequal valid counts, so n_eff sits strictly below n_Kish.
const s: StratumCounts[] = [
  { stratum: "chatgpt", weight: 0.2, successes: 9, trials: 40 },
  { stratum: "gemini", weight: 0.2, successes: 2, trials: 24 },
  { stratum: "perplexity", weight: 0.2, successes: 14, trials: 38 },
  { stratum: "claude", weight: 0.2, successes: 0, trials: 31 },
  { stratum: "google-ai-mode", weight: 0.2, successes: 5, trials: 40 },
];

const stratum = fc.integer({ min: 1, max: 40 }).chain((trials) =>
  fc.record({
    stratum: fc.string(),
    weight: fc.double({ min: 1e-6, max: 10, noNaN: true }),
    successes: fc.integer({ min: 0, max: trials }),
    trials: fc.constant(trials),
  }),
);

describe("estimateRate", () => {
  test("property: equal weights and equal n reduce exactly to Jeffreys on the totals", () =>
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 8 }), { minLength: 1, maxLength: 25 }),
        (ys) => {
          const r = estimateRate(
            ys.map((y, i) => ({ stratum: `s${i}`, weight: 1, successes: y, trials: 8 })),
          );
          const j = jeffreys(sum(ys), 8 * ys.length);
          return r.lower === j.lower && r.upper === j.upper && r.effectiveTrials === 8 * ys.length;
        },
      ),
    ));

  test("weights that do not add to 1 are normalized", () =>
    expect(estimateRate(withWeights([2, 2, 2]))).toEqual(
      estimateRate(withWeights([1 / 3, 1 / 3, 1 / 3])),
    ));

  test("a stratum with zero trials is dropped and the rest renormalized", () => {
    const r = estimateRate([
      { stratum: "a", weight: 0.5, successes: 0, trials: 0 },
      { stratum: "b", weight: 0.5, successes: 4, trials: 8 },
    ]);
    expect(r).toMatchObject({ estimate: 0.5, trials: 8, successes: 4 });
    expect(r).toEqual(estimateRate([{ stratum: "b", weight: 1, successes: 4, trials: 8 }]));
    expect(Number.isFinite(r.lower)).toBe(true);
    expect(Number.isFinite(r.upper)).toBe(true);
  });

  test("a zero-weight stratum does not count toward the trials", () =>
    expect(
      estimateRate([
        { stratum: "a", weight: 0, successes: 7, trials: 8 },
        { stratum: "b", weight: 1, successes: 2, trials: 8 },
      ]),
    ).toMatchObject({ estimate: 0.25, successes: 2, trials: 8 }));

  test("no stratum with trials is a range error, never NaN", () => {
    expect(() => estimateRate([{ stratum: "a", weight: 1, successes: 0, trials: 0 }])).toThrow(
      RangeError,
    );
    expect(() => estimateRate([])).toThrow(RangeError);
  });

  test("one run per variant has no clustering design effect", () => {
    const r = estimateRate(s);
    expect(r.effectiveTrials).toBeLessThan(r.trials);
    expect(r.designEffect).toBeCloseTo(r.trials / r.effectiveTrials, 12);
    expect(r.method).toBe("jeffreys_eff");
  });

  test("repeated runs shrink n_eff by 1 + (r − 1)·ρ, ρ floored at 0.10", () => {
    const base = estimateRate(s).effectiveTrials;
    expect(estimateRate(s, { runsPerVariant: 10 }).effectiveTrials).toBeCloseTo(base / 3.34, 6);
    expect(estimateRate(s, { runsPerVariant: 10, rho: 0.01 }).effectiveTrials).toBeCloseTo(
      base / 1.9,
      6,
    );
    const clustered = estimateRate(s, { runsPerVariant: 10 });
    expect(clustered.estimate).toBe(estimateRate(s).estimate);
    expect(clustered.upper - clustered.lower).toBeGreaterThan(
      estimateRate(s).upper - estimateRate(s).lower,
    );
  });

  test("the interval is Jeffreys on y* = p̂·n_eff", () => {
    const r = estimateRate(s);
    const j = jeffreys(r.estimate * r.effectiveTrials, r.effectiveTrials);
    expect(r.lower).toBe(j.lower);
    expect(r.upper).toBe(j.upper);
  });

  test("all failures and all successes pin the matching bound", () => {
    const none = estimateRate(s.map((x) => ({ ...x, successes: 0 })));
    expect(none).toMatchObject({ estimate: 0, lower: 0 });
    expect(none.upper).toBeGreaterThan(0);
    const all = estimateRate(s.map((x) => ({ ...x, successes: x.trials })));
    expect(all).toMatchObject({ estimate: 1, upper: 1 });
    expect(all.lower).toBeLessThan(1);
  });

  test("a tiny fractional y* keeps the estimate inside the interval", () => {
    const r = estimateRate([
      { stratum: "a", weight: 0.00007214510932528413, successes: 0, trials: 1 },
      { stratum: "b", weight: 0.000001, successes: 1, trials: 36 },
    ]);
    expect(jeffreys(r.estimate * r.effectiveTrials, r.effectiveTrials).lower).toBeGreaterThan(
      r.estimate,
    );
    expect(r.lower).toBe(r.estimate);
  });

  test("the estimate always lies inside its interval", () =>
    fc.assert(
      fc.property(
        fc.array(stratum, { minLength: 1, maxLength: 25 }),
        fc.integer({ min: 1, max: 10 }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        (strata, runsPerVariant, rho) => {
          const r = estimateRate(strata, { runsPerVariant, rho });
          return (
            r.lower >= 0 &&
            r.lower <= r.estimate &&
            r.estimate <= r.upper &&
            r.upper <= 1 &&
            Number.isFinite(r.effectiveTrials) &&
            r.effectiveTrials > 0
          );
        },
      ),
    ));
});
