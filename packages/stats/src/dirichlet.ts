import { exponential, gamma, type Rng } from "./rng";

/**
 * A stratum of the Bayesian bootstrap. `members` are the slots its weights are written to;
 * `rest` counts its other trials, whose weights only matter through their total.
 */
export interface DirichletStratum {
  weight: number;
  members: Int32Array;
  rest: number;
  /** Scratch: sorted cuts for spacings, or the members' Exp(1) draws. */
  cuts: Float64Array;
}

export function dirichletStratum(
  weight: number,
  members: ArrayLike<number>,
  rest = 0,
): DirichletStratum {
  return {
    weight,
    members: Int32Array.from(members),
    rest,
    cuts: new Float64Array(rest === 0 ? Math.max(0, members.length - 1) : members.length),
  };
}

// Up to here m uniforms and one logarithm cost less than a Marsaglia–Tsang draw.
const ERLANG_PRODUCT_MAX = 8;

/** Gamma(m, 1) for a positive integer m. */
function erlang(rng: Rng, m: number): number {
  if (m > ERLANG_PRODUCT_MAX) return gamma(rng, m);
  // 1 − U lies in (0, 1], and 8 factors at 2^-32 resolution stay far from underflow.
  let product = 1;
  for (let j = 0; j < m; j++) product *= 1 - rng.next();
  return -Math.log(product);
}

/**
 * One draw of the stratified Bayesian bootstrap: Dirichlet(1,…,1) over the trials of each
 * stratum, scaled by its fixed weight W_h, so `out[offset + member] = W_h · E_i / Σ_{j∈h} E_j`
 * in distribution. Stratum masses stay at W_h by design instead of picking up resampling noise.
 */
export function drawStratifiedDirichlet(
  rng: Rng,
  strata: readonly DirichletStratum[],
  out: Float64Array,
  offset = 0,
): void {
  for (const { weight, members, rest, cuts } of strata) {
    if (rest === 0) {
      // A whole stratum: the spacings of m − 1 sorted uniforms are exactly Dirichlet(1,…,1)
      // and need no logarithms.
      for (let j = 0; j < cuts.length; j++) cuts[j] = rng.next();
      cuts.sort();
      let previous = 0;
      for (let j = 0; j < members.length; j++) {
        const cut = j < cuts.length ? (cuts[j] as number) : 1;
        out[offset + (members[j] as number)] = weight * (cut - previous);
        previous = cut;
      }
      continue;
    }
    // Part of a stratum: the other trials enter only through the total of their Exp(1) draws,
    // which is Gamma(rest), so one draw replaces `rest` and the result stays exact.
    let total = erlang(rng, rest);
    for (let j = 0; j < members.length; j++) {
      const e = exponential(rng);
      cuts[j] = e;
      total += e;
    }
    for (let j = 0; j < members.length; j++) {
      out[offset + (members[j] as number)] = (weight * (cuts[j] as number)) / total;
    }
  }
}
