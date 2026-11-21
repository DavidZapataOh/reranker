import betaln from "@stdlib/math-base-special-betaln";

/** Run-length posterior in log space, with the Beta parameters each run length has seen. */
export interface BocpdState {
  logR: number[];
  a: number[];
  b: number[];
}

export interface BocpdOptions {
  /** Expected days between changes: a constant hazard of 1/lambda. */
  lambda?: number;
  /** The last run length stands for this many days or more. */
  maxRunLength?: number;
  /** Trailing run lengths less likely than this are dropped. */
  prune?: number;
}

const DEFAULTS = { lambda: 30, maxRunLength: 400, prune: 1e-6 } as const;
const PRIOR = { a: 1, b: 1 } as const;

function logSumExp(xs: readonly number[]): number {
  const max = Math.max(...xs);
  if (max === Number.NEGATIVE_INFINITY) return max;
  let sum = 0;
  for (const x of xs) sum += Math.exp(x - max);
  return max + Math.log(sum);
}

function logChoose(n: number, k: number): number {
  return -Math.log(n + 1) - betaln(n - k + 1, k + 1);
}

/** A state before any day: every run starts now, under the Beta prior. */
export function bocpdInit(prior: { a: number; b: number } = PRIOR): BocpdState {
  if (!(prior.a > 0 && prior.b > 0)) throw new RangeError("Beta prior parameters must be positive");
  return { logR: [0], a: [prior.a], b: [prior.b] };
}

/**
 * One day of Bayesian online changepoint detection (Adams and MacKay, 2007) on y successes in
 * n runs, with a Beta-Binomial predictive per run length. The prior of a new run is the one the
 * state started from.
 */
export function bocpdStep(
  s: BocpdState,
  y: number,
  n: number,
  opts: BocpdOptions = {},
): { state: BocpdState; mapRunLength: number } {
  if (!(Number.isInteger(n) && n > 0 && Number.isInteger(y) && y >= 0 && y <= n)) {
    throw new RangeError(`bocpdStep needs integers 0 ≤ y ≤ n, n > 0; got y=${y}, n=${n}`);
  }
  const { lambda, maxRunLength, prune } = { ...DEFAULTS, ...opts };
  const a0 = s.a[0] ?? PRIOR.a;
  const b0 = s.b[0] ?? PRIOR.b;
  const logHazard = Math.log(1 / lambda);
  const logSurvive = Math.log1p(-1 / lambda);
  const choose = logChoose(n, y);

  const joint = s.logR.map((logR, r) => {
    const a = s.a[r] as number;
    const b = s.b[r] as number;
    return logR + choose + betaln(y + a, n - y + b) - betaln(a, b);
  });
  let logR = [logSumExp(joint.map((j) => j + logHazard)), ...joint.map((j) => j + logSurvive)];
  let a = [a0, ...s.a.map((v) => v + y)];
  let b = [b0, ...s.b.map((v) => v + n - y)];
  let norm = logSumExp(logR);
  logR = logR.map((v) => v - norm);

  // The run that outgrew the window joins the last run length, keeping its own counts.
  if (logR.length > maxRunLength + 1) {
    logR[maxRunLength] = logSumExp([
      logR[maxRunLength] as number,
      logR[maxRunLength + 1] as number,
    ]);
    a[maxRunLength] = a[maxRunLength + 1] as number;
    b[maxRunLength] = b[maxRunLength + 1] as number;
    logR = logR.slice(0, maxRunLength + 1);
    a = a.slice(0, maxRunLength + 1);
    b = b.slice(0, maxRunLength + 1);
  }
  let keep = logR.length;
  while (keep > 1 && Math.exp(logR[keep - 1] as number) < prune) keep -= 1;
  if (keep < logR.length) {
    logR = logR.slice(0, keep);
    a = a.slice(0, keep);
    b = b.slice(0, keep);
    norm = logSumExp(logR);
    logR = logR.map((v) => v - norm);
  }

  let mapRunLength = 0;
  for (let r = 1; r < logR.length; r++) {
    if ((logR[r] as number) > (logR[mapRunLength] as number)) mapRunLength = r;
  }
  return { state: { logR, a, b }, mapRunLength };
}
