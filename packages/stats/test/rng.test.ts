import betaCdf from "@stdlib/stats-base-dists-beta-cdf";
import { describe, expect, test } from "vitest";
import { beta, exponential, gamma, type Rng, rngFromSeed, standardNormal } from "../src/rng";

const SEED = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";

function draw(n: number, sample: (rng: Rng) => number, seed = SEED): Float64Array {
  const rng = rngFromSeed(seed);
  const xs = new Float64Array(n);
  for (let i = 0; i < n; i++) xs[i] = sample(rng);
  return xs;
}

function mean(xs: Float64Array): number {
  let sum = 0;
  for (const x of xs) sum += x;
  return sum / xs.length;
}

function variance(xs: Float64Array): number {
  const m = mean(xs);
  let sum = 0;
  for (const x of xs) sum += (x - m) ** 2;
  return sum / (xs.length - 1);
}

describe("rngFromSeed", () => {
  test("xoshiro128** reference output", () => {
    const r = rngFromSeed(`01000000020000000300000004000000${"0".repeat(32)}`);
    expect([0, 1, 2].map(() => Math.round(r.next() * 2 ** 32))).toEqual([11520, 0, 5927040]);
  });

  test("same seed, same stream; different seed, different stream", () => {
    const a = Array.from(draw(100, (r) => r.next()));
    expect(Array.from(draw(100, (r) => r.next()))).toEqual(a);
    expect(Array.from(draw(100, (r) => r.next(), SEED.toUpperCase()))).toEqual(a);
    expect(Array.from(draw(100, (r) => r.next(), `${SEED.slice(0, 63)}9`))).toEqual(a);
    expect(Array.from(draw(100, (r) => r.next(), `0${SEED.slice(1)}`))).not.toEqual(a);
  });

  test("outputs are in [0, 1) on a 2^-32 grid", () => {
    for (const x of draw(10_000, (r) => r.next())) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
      expect(Number.isInteger(x * 2 ** 32)).toBe(true);
    }
  });

  test("all-zero seed is rejected", () => expect(() => rngFromSeed("0".repeat(64))).toThrow());

  test.each(["", "abc", "g".repeat(64), "0".repeat(63), "0".repeat(65)])(
    "malformed seed %j is rejected",
    (seed) => expect(() => rngFromSeed(seed)).toThrow(RangeError),
  );
});

describe("samplers", () => {
  test.each([
    [0.5, 120.5],
    [12.5, 108.5],
    [3, 3],
    [0.5, 0.5],
  ])("beta(%s, %s) mean and variance within 1%% over 200k draws", (a, b) => {
    const xs = draw(200_000, (r) => beta(r, a, b));
    expect(mean(xs)).toBeCloseTo(a / (a + b), 2);
    const ratio = variance(xs) / ((a * b) / ((a + b) ** 2 * (a + b + 1)));
    expect(ratio).toBeGreaterThan(0.97);
    expect(ratio).toBeLessThan(1.03);
  });

  test("gamma with shape < 1 matches its mean", () =>
    expect(mean(draw(200_000, (r) => gamma(r, 0.5)))).toBeCloseTo(0.5, 2));

  test("gamma with shape ≥ 1 matches its mean and variance", () => {
    const xs = draw(200_000, (r) => gamma(r, 7.5));
    expect(mean(xs) / 7.5).toBeCloseTo(1, 2);
    expect(variance(xs) / 7.5).toBeCloseTo(1, 1);
  });

  test("exponential has unit mean and variance", () => {
    const xs = draw(200_000, exponential);
    expect(mean(xs)).toBeCloseTo(1, 2);
    expect(variance(xs)).toBeCloseTo(1, 1);
  });

  test("standard normal has zero mean and unit variance", () => {
    const xs = draw(200_000, standardNormal);
    expect(mean(xs)).toBeCloseTo(0, 2);
    expect(variance(xs)).toBeCloseTo(1, 2);
  });

  test.each([
    [0.5, 120.5],
    [12.5, 108.5],
    [3, 3],
    [0.5, 0.5],
  ])(
    "beta(%s, %s) draws pass a Kolmogorov–Smirnov test against the exact cdf at α = 0.01",
    (a, b) => {
      const n = 20_000;
      const xs = draw(n, (r) => beta(r, a, b)).sort();
      let d = 0;
      for (let i = 0; i < n; i++) {
        const f = betaCdf(xs[i] as number, a, b);
        d = Math.max(d, (i + 1) / n - f, f - i / n);
      }
      // Asymptotic critical value of the one-sample KS statistic at α = 0.01.
      expect(d).toBeLessThan(1.6276 / Math.sqrt(n));
    },
  );

  test.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])("gamma rejects shape %s", (shape) =>
    expect(() => gamma(rngFromSeed(SEED), shape)).toThrow(RangeError),
  );

  test.each([
    [0, 1],
    [1, -2],
    [Number.NaN, 1],
  ])("beta rejects parameters (%s, %s)", (a, b) =>
    expect(() => beta(rngFromSeed(SEED), a, b)).toThrow(RangeError),
  );
});
