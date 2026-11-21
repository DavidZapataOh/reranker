// Calibrates the CUSUM threshold h (in units of sigma) for every baseline rate p of a canary
// prompt measured over ten runs a day, as simulations/cusum_h_arl.py does: bisection on h
// until a one-sided chart with known parameters has an in-control ARL of 180 days (two
// one-sided charts give about 90). Writes src/changepoint/h-table.json.
//
//   pnpm --filter @reranker/stats changepoint:calibrate
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { type Rng, rngFromSeed } from "../src/rng";

const N_RUNS = 10;
const TARGET_ONE_SIDED = 180;
const REFERENCE_DAYS = 400_000;
const REPS = 2000;
const MAX_DAYS = 3000;
const BISECTIONS = 16;
const SEED = createHash("sha256").update("reranker:changepoint:h-calibration:v1").digest("hex");
const PS = Array.from({ length: 19 }, (_, i) => Math.round((i + 1) * 5) / 100);

/** Binomial(10, p) by inversion: one uniform per day keeps 10^9 draws within minutes. */
function binomialSampler(p: number): (rng: Rng) => number {
  const cdf: number[] = [];
  let acc = 0;
  for (let y = 0; y <= N_RUNS; y++) {
    let choose = 1;
    for (let i = 0; i < y; i++) choose = (choose * (N_RUNS - i)) / (i + 1);
    acc += choose * p ** y * (1 - p) ** (N_RUNS - y);
    cdf.push(acc);
  }
  return (rng) => {
    const u = rng.next();
    let y = 0;
    while (y < N_RUNS && u >= (cdf[y] as number)) y++;
    return y;
  };
}

const LOGITS = Array.from({ length: N_RUNS + 1 }, (_, y) =>
  Math.log((y + 0.5) / (N_RUNS - y + 0.5)),
);

function averageRunLength(
  draw: (rng: Rng) => number,
  rng: Rng,
  mu: number,
  sd: number,
  h: number,
): number {
  const k = 0.5 * sd;
  const limit = h * sd;
  let total = 0;
  for (let rep = 0; rep < REPS; rep++) {
    let s = 0;
    let length = MAX_DAYS;
    for (let t = 1; t <= MAX_DAYS; t++) {
      s = Math.max(0, s + ((LOGITS[draw(rng)] as number) - mu) - k);
      if (s > limit) {
        length = t;
        break;
      }
    }
    total += length;
  }
  return total / REPS;
}

function calibrate(p: number, rng: Rng): number {
  const draw = binomialSampler(p);
  let sum = 0;
  let sumSq = 0;
  for (let i = 0; i < REFERENCE_DAYS; i++) {
    const x = LOGITS[draw(rng)] as number;
    sum += x;
    sumSq += x * x;
  }
  const mu = sum / REFERENCE_DAYS;
  const sd = Math.sqrt(sumSq / REFERENCE_DAYS - mu * mu);
  let lo = 0.5;
  let hi = 10;
  let h = (lo + hi) / 2;
  for (let i = 0; i < BISECTIONS; i++) {
    h = (lo + hi) / 2;
    if (averageRunLength(draw, rng, mu, sd, h) < TARGET_ONE_SIDED) lo = h;
    else hi = h;
  }
  return Math.round(h * 1000) / 1000;
}

const rng = rngFromSeed(SEED);
const points = PS.map((p) => {
  const h = calibrate(p, rng);
  console.info(`p=${p} h=${h}`);
  return { p, h };
});
const table = {
  method: "simulations/calibrate-h.ts",
  calibratedOn: new Date().toISOString().slice(0, 10),
  seed: SEED,
  runsPerDay: N_RUNS,
  oneSidedArl: TARGET_ONE_SIDED,
  reps: REPS,
  points,
};
writeFileSync(
  new URL("../src/changepoint/h-table.json", import.meta.url),
  `${JSON.stringify(table, null, 2)}\n`,
);
