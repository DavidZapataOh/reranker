import H_TABLE from "./h-table.json" with { type: "json" };

/** ln((y + 0.5) / (n − y + 0.5)): finite at y = 0 and y = n, unlike the plain logit. */
export function empiricalLogit(y: number, n: number): number {
  if (!(Number.isInteger(n) && n > 0 && Number.isInteger(y) && y >= 0 && y <= n)) {
    throw new RangeError(`empiricalLogit needs integers 0 ≤ y ≤ n, n > 0; got y=${y}, n=${n}`);
  }
  return Math.log((y + 0.5) / (n - y + 0.5));
}

/**
 * The CUSUM threshold, in units of sigma, that gives a one-sided in-control ARL of 180 days for
 * a daily rate p measured over ten runs: linear between the calibrated points, clamped outside.
 */
export function hFor(p: number): number {
  if (!(p >= 0 && p <= 1)) throw new RangeError(`p must be in [0, 1], got ${p}`);
  const points = H_TABLE.points;
  const first = points[0];
  const last = points[points.length - 1];
  if (!first || !last) throw new Error("h-table.json has no points");
  if (p <= first.p) return first.h;
  if (p >= last.p) return last.h;
  const upper = points.findIndex((point) => point.p >= p);
  const hi = points[upper];
  const lo = points[upper - 1];
  if (!hi || !lo) return last.h;
  return lo.h + ((hi.h - lo.h) * (p - lo.p)) / (hi.p - lo.p);
}

export interface CusumBaseline {
  mu0: number;
  sigma: number;
  h: number;
}

/**
 * Mean and sample standard deviation (ddof 1) of the baseline logits, with h for the baseline
 * rate p. Null without variation: a sigma of zero would make any change an alarm.
 */
export function cusumBaseline(xs: readonly number[], p: number): CusumBaseline | null {
  if (xs.length < 2) throw new RangeError("a CUSUM baseline needs at least two days");
  // Daily logits are discrete, so no variation is exact equality; the computed
  // sigma of equal values can still come out as rounding noise above zero.
  if (xs.every((x) => x === xs[0])) return null;
  const mu0 = xs.reduce((sum, x) => sum + x, 0) / xs.length;
  const ss = xs.reduce((sum, x) => sum + (x - mu0) ** 2, 0);
  const sigma = Math.sqrt(ss / (xs.length - 1));
  return { mu0, sigma, h: hFor(p) };
}

/** One day of a two-sided CUSUM with reference value k·sigma; alarm past h·sigma on either side. */
export function cusumStep(
  s: { up: number; down: number },
  x: number,
  b: CusumBaseline,
  k = 0.5,
): { up: number; down: number; alarm: boolean } {
  const up = Math.max(0, s.up + (x - b.mu0) - k * b.sigma);
  const down = Math.max(0, s.down + (b.mu0 - x) - k * b.sigma);
  const limit = b.h * b.sigma;
  return { up, down, alarm: up > limit || down > limit };
}
