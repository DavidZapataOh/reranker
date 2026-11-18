import betaCdf from "@stdlib/stats-base-dists-beta-cdf";
import { describe, expect, test } from "vitest";
import { beta, exponential, gamma, type Rng, standardNormal } from "../src/rng";
import { draw } from "./fixtures";

interface Moments {
  mean: number;
  variance: number;
  excessKurtosis: number;
}

// Each check sits Z standard errors from the truth, so a correct sampler passes for any seed with
// probability ≈ 1 − 6·10⁻⁵ per check, and a fixed seed cannot hide an under-powered one.
const Z = 4;
// The mean within 1% (of the mean, or of σ when the mean is 0) and the variance within 3%.
const MEAN_TOLERANCE = 0.01;
const VARIANCE_TOLERANCE = 0.03;

const meanScale = (m: Moments) => (m.mean === 0 ? Math.sqrt(m.variance) : Math.abs(m.mean));

// SE(mean) = σ/√n and SE(s²/σ²) ≈ √((κ − 1)/n) with κ = excess kurtosis + 3, so the smallest n
// that holds both tolerances at Z standard errors is the larger of the two.
function drawsFor(m: Moments): number {
  const forMean = ((Z * Math.sqrt(m.variance)) / (MEAN_TOLERANCE * meanScale(m))) ** 2;
  const forVariance = (Z ** 2 * (m.excessKurtosis + 2)) / VARIANCE_TOLERANCE ** 2;
  return Math.ceil(Math.max(forMean, forVariance));
}

function betaMoments(a: number, b: number): Moments {
  const s = a + b;
  return {
    mean: a / s,
    variance: (a * b) / (s ** 2 * (s + 1)),
    excessKurtosis: (6 * ((a - b) ** 2 * (s + 1) - a * b * (s + 2))) / (a * b * (s + 2) * (s + 3)),
  };
}

const gammaMoments = (k: number): Moments => ({ mean: k, variance: k, excessKurtosis: 6 / k });

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

describe("samplers", () => {
  test.each<[string, (rng: Rng) => number, Moments]>([
    ["beta(0.5, 120.5)", (r) => beta(r, 0.5, 120.5), betaMoments(0.5, 120.5)],
    ["beta(12.5, 108.5)", (r) => beta(r, 12.5, 108.5), betaMoments(12.5, 108.5)],
    ["beta(3, 3)", (r) => beta(r, 3, 3), betaMoments(3, 3)],
    ["beta(0.5, 0.5)", (r) => beta(r, 0.5, 0.5), betaMoments(0.5, 0.5)],
    ["gamma(0.5)", (r) => gamma(r, 0.5), gammaMoments(0.5)],
    ["gamma(7.5)", (r) => gamma(r, 7.5), gammaMoments(7.5)],
    ["exponential", exponential, gammaMoments(1)],
    ["standard normal", standardNormal, { mean: 0, variance: 1, excessKurtosis: 0 }],
  ])("%s matches its mean within 1% and its variance within 3%", (_, sample, moments) => {
    const xs = draw(drawsFor(moments), sample);
    expect(Math.abs(mean(xs) - moments.mean)).toBeLessThanOrEqual(
      MEAN_TOLERANCE * meanScale(moments),
    );
    expect(Math.abs(variance(xs) / moments.variance - 1)).toBeLessThanOrEqual(VARIANCE_TOLERANCE);
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
});
