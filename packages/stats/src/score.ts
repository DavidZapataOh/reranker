import type { RateEstimate, ScoreEstimate } from "@reranker/schema/measurement";
import { type DirichletStratum, dirichletStratum, drawStratifiedDirichlet } from "./dirichlet";
import { levelDisplay, levelOf, sufficiency } from "./levels";
import { methodology } from "./methodology";
import { estimateRate, type StratumCounts } from "./rate";
import { beta, rngFromSeed } from "./rng";

export interface EntityObservation {
  captureIndex: number;
  stratum: string;
  weight: number;
  y: 0 | 1;
  ordinal: number | null;
  isCanonical: boolean;
}

interface Prominence {
  discounts: Float64Array;
  /** Bootstrap strata whose members index `discounts`; the rest of each stratum is `rest`. */
  strata: DirichletStratum[];
  estimate: number;
  min: number;
  max: number;
}

interface Point {
  rate: RateEstimate;
  prominence: Prominence | null;
  value: number;
}

function strataOf(obs: readonly EntityObservation[]): Map<string, StratumCounts> {
  const strata = new Map<string, StratumCounts>();
  for (const o of obs) {
    const s = strata.get(o.stratum);
    if (s === undefined) {
      strata.set(o.stratum, { stratum: o.stratum, weight: o.weight, successes: o.y, trials: 1 });
      continue;
    }
    if (s.weight !== o.weight) {
      throw new RangeError(`stratum ${o.stratum} has observations with different weights`);
    }
    s.successes += o.y;
    s.trials += 1;
  }
  return strata;
}

function prominenceOf(
  obs: readonly EntityObservation[],
  strata: Map<string, StratumCounts>,
): Prominence | null {
  const discounts: number[] = [];
  const ranked = new Map<string, { stratum: StratumCounts; members: number[] }>();
  let num = 0;
  let den = 0;
  for (const o of obs) {
    // An unranked recommendation still counts in p̂; it just says nothing about position.
    if (o.y !== 1 || o.ordinal === null || o.weight === 0) continue;
    let r = ranked.get(o.stratum);
    if (r === undefined) {
      r = { stratum: strata.get(o.stratum) as StratumCounts, members: [] };
      ranked.set(o.stratum, r);
    }
    const discount = methodology.positionDiscount ** (o.ordinal - 1);
    const coefficient = o.weight / r.stratum.trials;
    r.members.push(discounts.length);
    discounts.push(discount);
    num += coefficient * discount;
    den += coefficient;
  }
  if (discounts.length === 0) return null;

  return {
    discounts: Float64Array.from(discounts),
    strata: [...ranked.values()].map(({ stratum, members }) =>
      dirichletStratum(stratum.weight, members, stratum.trials - members.length),
    ),
    estimate: num / den,
    min: Math.min(...discounts),
    max: Math.max(...discounts),
  };
}

function point(obs: readonly EntityObservation[], runsPerVariant = 1): Point {
  const strata = strataOf(obs);
  const rate = estimateRate([...strata.values()], { runsPerVariant });
  const prominence = rate.successes === 0 ? null : prominenceOf(obs, strata);
  // With no ranked recommendation G = 1, the conservative upper bound of the discount.
  const value = Math.round(100 * rate.estimate * (prominence?.estimate ?? 1));
  return { rate, prominence, value };
}

/** Type 7 quantile (linear interpolation between order statistics) of sorted draws. */
function quantile(sorted: Float64Array, q: number): number {
  const h = (sorted.length - 1) * q;
  const lo = Math.floor(h);
  const below = sorted[lo] as number;
  const above = sorted[Math.min(lo + 1, sorted.length - 1)] as number;
  return below + (h - lo) * (above - below);
}

const clampScore = (n: number) => Math.min(100, Math.max(0, n));

export function pointScore(obs: EntityObservation[]): number {
  return point(obs).value;
}

export function estimateScore(
  obs: EntityObservation[],
  seed: string,
  opts: { preliminary?: boolean; runsPerVariant?: number } = {},
): ScoreEstimate {
  const { rate, prominence, value } = point(obs, opts.runsPerVariant);
  const tail = (1 - methodology.confidenceLevel) / 2;

  let lower: number;
  let upper: number;
  let atMost: number | null = null;
  let gLower = 1;
  let gUpper = 1;

  if (rate.successes === 0) {
    // The exact Jeffreys bound, not a Monte Carlo quantile, so "a lo sumo" is reproducible
    // from the counts alone.
    lower = 0;
    upper = clampScore(Math.ceil(100 * rate.upper));
    atMost = upper;
  } else {
    const rng = rngFromSeed(seed);
    const draws = methodology.mcDraws;
    const scores = new Float64Array(draws);
    const gs = new Float64Array(draws);
    const nEff = rate.effectiveTrials;
    const ySt = Math.min(rate.estimate * nEff, nEff);
    // With a single discount value G is that constant, so only mixed ranks need the bootstrap.
    const ranked = prominence !== null && prominence.min < prominence.max ? prominence : null;
    const buffer = new Float64Array(ranked?.discounts.length ?? 0);

    for (let s = 0; s < draws; s++) {
      const p = beta(rng, ySt + 0.5, nEff - ySt + 0.5);
      let g = prominence?.estimate ?? 1;
      if (ranked !== null) {
        drawStratifiedDirichlet(rng, ranked.strata, buffer);
        let num = 0;
        let den = 0;
        for (let i = 0; i < buffer.length; i++) {
          const w = buffer[i] as number;
          num += w * (ranked.discounts[i] as number);
          den += w;
        }
        // A convex combination of the discounts; the clamp only removes rounding past them. Every
        // weight is 0 only if the uniforms collide at 2^-32 resolution; Ĝ then stands in.
        if (den > 0) g = Math.min(ranked.max, Math.max(ranked.min, num / den));
      }
      gs[s] = g;
      scores[s] = 100 * p * g;
    }
    scores.sort();
    gs.sort();

    // Rounding the quantiles outward can still leave the central value outside them when few
    // recommendations sit at scattered ranks, and the range must always contain it.
    lower = clampScore(Math.min(value, Math.floor(quantile(scores, tail))));
    upper = clampScore(Math.max(value, Math.ceil(quantile(scores, 1 - tail))));
    const gHat = prominence?.estimate ?? 1;
    gLower = Math.min(gHat, quantile(gs, tail));
    gUpper = Math.max(gHat, quantile(gs, 1 - tail));
  }

  return {
    value,
    lower,
    upper,
    atMost,
    level: levelOf(value),
    levelDisplay: levelDisplay(lower, upper),
    sufficiency: sufficiency(lower, upper),
    preliminary: opts.preliminary ?? true,
    components: {
      recommendationRate: rate,
      prominence: {
        estimate: prominence?.estimate ?? 1,
        lower: gLower,
        upper: gUpper,
        typicalPosition:
          prominence === null
            ? null
            : Math.round(
                1 + Math.log(prominence.estimate) / Math.log(methodology.positionDiscount),
              ),
      },
    },
  };
}
