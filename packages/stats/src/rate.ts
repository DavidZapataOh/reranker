import type { RateEstimate } from "@reranker/schema/measurement";
import { clusterDeff, effectiveSize, jeffreys } from "./interval";
import { methodology } from "./methodology";

export interface StratumCounts {
  stratum: string;
  weight: number;
  successes: number;
  trials: number;
}

export function estimateRate(
  obs: readonly StratumCounts[],
  opts: { runsPerVariant?: number; rho?: number } = {},
): RateEstimate {
  // An empty or weightless stratum adds nothing to p̂, so it leaves the design and the
  // remaining weights renormalize instead of dividing by zero.
  const strata = obs.filter((s) => s.trials !== 0 && s.weight !== 0);
  if (strata.length === 0) throw new RangeError("no stratum has both trials and weight");

  const { estimate, nEff } = effectiveSize(strata);
  const trials = strata.reduce((sum, s) => sum + s.trials, 0);
  const successes = strata.reduce((sum, s) => sum + s.successes, 0);

  const rho = Math.max(opts.rho ?? methodology.rho.prior, methodology.rho.floor);
  const deff = clusterDeff(opts.runsPerVariant ?? 1, rho);
  const effectiveTrials = nEff / deff;
  // n_eff equals the total only when the design is self-weighting; scaling the integer count
  // then keeps the exact reduction to Jeffreys on the totals that p̂·n_eff would round away.
  const effectiveSuccesses = nEff === trials ? successes / deff : estimate * effectiveTrials;

  const interval = jeffreys(Math.min(effectiveSuccesses, effectiveTrials), effectiveTrials);
  return {
    estimate,
    // A fractional y* near 0 or n_eff can push a Beta quantile past p̂ itself.
    lower: Math.min(interval.lower, estimate),
    upper: Math.max(interval.upper, estimate),
    successes,
    trials,
    effectiveTrials,
    designEffect: trials / effectiveTrials,
    method: "jeffreys_eff",
  };
}
