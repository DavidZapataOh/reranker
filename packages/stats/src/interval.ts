import type { RateEstimate } from "@reranker/schema/measurement";
import betaQuantile from "@stdlib/stats-base-dists-beta-quantile";
import { methodology } from "./methodology";

export interface Interval {
  lower: number;
  upper: number;
}

export interface WeightedStratum {
  weight: number;
  successes: number;
  trials: number;
}

function assertLevel(level: number): void {
  if (!(level > 0 && level < 1)) throw new RangeError(`level must be in (0, 1), got ${level}`);
}

function assertCounts(successes: number, trials: number): void {
  if (!(Number.isFinite(trials) && trials > 0)) {
    throw new RangeError(`trials must be finite and positive, got ${trials}`);
  }
  if (!(successes >= 0 && successes <= trials)) {
    throw new RangeError(`successes must be in [0, ${trials}], got ${successes}`);
  }
}

// Brown, Cai and DasGupta's modification: the raw Beta quantile at y = 0 (or y = n) is a
// meaningless sliver away from the boundary, so the bound is pinned to it.
export function jeffreys(
  successes: number,
  trials: number,
  level: number = methodology.confidenceLevel,
): Interval {
  assertCounts(successes, trials);
  assertLevel(level);
  const tail = (1 - level) / 2;
  const a = successes + 0.5;
  const b = trials - successes + 0.5;
  return {
    lower: successes === 0 ? 0 : betaQuantile(tail, a, b),
    upper: successes === trials ? 1 : betaQuantile(1 - tail, a, b),
  };
}

export function wilson(
  successes: number,
  trials: number,
  level: number = methodology.confidenceLevel,
): Interval {
  assertCounts(successes, trials);
  assertLevel(level);
  const z = normalQuantile(1 - (1 - level) / 2);
  const z2 = z * z;
  const p = successes / trials;
  const denominator = 1 + z2 / trials;
  const center = (p + z2 / (2 * trials)) / denominator;
  const half = (z * Math.sqrt((p * (1 - p)) / trials + z2 / (4 * trials * trials))) / denominator;
  // The closed form hits 0 and 1 exactly at the boundaries; rounding would leave ±1e-18.
  return {
    lower: successes === 0 ? 0 : Math.max(0, center - half),
    upper: successes === trials ? 1 : Math.min(1, center + half),
  };
}

// Wichura's AS 241 (PPND16), accurate to about 1e-16: the algorithm behind R's qnorm.
// Coefficients are the published ones written as their nearest doubles, highest degree first.
const CENTRAL_NUM = [
  2509.0809287301227, 33430.57558358813, 67265.7709270087, 45921.95393154987, 13731.69376550946,
  1971.5909503065513, 133.14166789178438, 3.3871328727963665,
];
const CENTRAL_DEN = [
  5226.495278852546, 28729.085735721943, 39307.89580009271, 21213.794301586597, 5394.196021424751,
  687.1870074920579, 42.31333070160091, 1,
];
const NEAR_NUM = [
  0.0007745450142783414, 0.022723844989269184, 0.2417807251774506, 1.2704582524523684,
  3.6478483247632045, 5.769497221460691, 4.630337846156546, 1.4234371107496835,
];
const NEAR_DEN = [
  1.0507500716444169e-9, 0.0005475938084995345, 0.015198666563616457, 0.14810397642748008,
  0.6897673349851, 1.6763848301838038, 2.053191626637759, 1,
];
const FAR_NUM = [
  2.0103343992922881e-7, 0.000027115555687434876, 0.0012426609473880784, 0.026532189526576124,
  0.29656057182850487, 1.7848265399172913, 5.463784911164114, 6.657904643501103,
];
const FAR_DEN = [
  2.0442631033899397e-15, 1.421511758316446e-7, 0.000018463183175100548, 0.0007868691311456133,
  0.014875361290850615, 0.1369298809227358, 0.599832206555888, 1,
];

function horner(coefficients: readonly number[], x: number): number {
  return coefficients.reduce((acc, c) => acc * x + c, 0);
}

export function normalQuantile(p: number): number {
  if (!(p > 0 && p < 1)) throw new RangeError(`p must be in (0, 1), got ${p}`);
  const q = p - 0.5;
  if (Math.abs(q) <= 0.425) {
    const r = 0.180625 - q * q;
    return (q * horner(CENTRAL_NUM, r)) / horner(CENTRAL_DEN, r);
  }
  const r = Math.sqrt(-Math.log(q < 0 ? p : 1 - p));
  const value =
    r <= 5
      ? horner(NEAR_NUM, r - 1.6) / horner(NEAR_DEN, r - 1.6)
      : horner(FAR_NUM, r - 5) / horner(FAR_DEN, r - 5);
  return q < 0 ? -value : value;
}

function assertStrata(strata: readonly WeightedStratum[]): void {
  if (strata.length === 0) throw new RangeError("at least one stratum is required");
  for (const { weight, successes, trials } of strata) {
    if (!(Number.isFinite(weight) && weight >= 0)) {
      throw new RangeError(`weights must be finite and non-negative, got ${weight}`);
    }
    assertCounts(successes, trials);
  }
}

// When every weight is proportional to its trials the stratified estimator is the pooled
// proportion and n_eff is the total (p̂(1−p̂)/v̂ ≥ n by concavity); computing that directly keeps
// the self-weighting design an exact reduction to Jeffreys on the totals, free of rounding.
function isSelfWeighting(strata: readonly WeightedStratum[]): boolean {
  const [first] = strata as [WeightedStratum, ...WeightedStratum[]];
  return strata.every((s) => s.weight * first.trials === first.weight * s.trials);
}

export function effectiveSize(strata: readonly WeightedStratum[]): {
  estimate: number;
  nEff: number;
  nKish: number;
  variance: number;
} {
  assertStrata(strata);
  const totalWeight = strata.reduce((sum, s) => sum + s.weight, 0);
  if (!(totalWeight > 0)) throw new RangeError("the weights must not all be zero");

  let estimate = 0;
  let variance = 0;
  let kishDenominator = 0;
  for (const { weight, successes, trials } of strata) {
    const w = weight / totalWeight;
    const mean = successes / trials;
    estimate += w * mean;
    variance += (w * w * mean * (1 - mean)) / trials;
    kishDenominator += (w * w) / trials;
  }

  if (isSelfWeighting(strata)) {
    const trials = strata.reduce((sum, s) => sum + s.trials, 0);
    const successes = strata.reduce((sum, s) => sum + s.successes, 0);
    return { estimate: successes / trials, nEff: trials, nKish: trials, variance };
  }

  const nKish = 1 / kishDenominator;
  const degenerate = estimate <= 0 || estimate >= 1 || variance <= 0;
  const nEff = degenerate ? nKish : Math.min((estimate * (1 - estimate)) / variance, nKish);
  return { estimate, nEff, nKish, variance };
}

export function clusterDeff(runsPerVariant: number, rho: number): number {
  if (!(runsPerVariant >= 1)) {
    throw new RangeError(`runsPerVariant must be ≥ 1, got ${runsPerVariant}`);
  }
  if (!(rho >= 0 && rho <= 1)) throw new RangeError(`rho must be in [0, 1], got ${rho}`);
  return 1 + (runsPerVariant - 1) * rho;
}

export function wilsonDivergence(rate: RateEstimate): number {
  const n = rate.effectiveTrials;
  const successes = Math.min(Math.max(rate.estimate * n, 0), n);
  const w = wilson(successes, n);
  return 100 * Math.max(Math.abs(rate.lower - w.lower), Math.abs(rate.upper - w.upper));
}
