import { createHash } from "node:crypto";
import { expect, test } from "vitest";
import {
  type CusumBaseline,
  cusumBaseline,
  cusumStep,
  empiricalLogit,
  regimeAlarm,
} from "../src/changepoint";
import { type Rng, rngFromSeed } from "../src/rng";

// The engine-level rule of simulations/linea_base_canario.py: 50 prompts at p 0.2 or 0.5, ten
// runs a day, a 42-day baseline, then 90 days. h comes from the baseline's own rate, as the
// canary sets it. The seed is fixed and never changed to make the test pass.
const N_RUNS = 10;
const PROMPTS = 50;
const BASELINE_DAYS = 42;
const HORIZON = 90;
const SEED = createHash("sha256").update("reranker:changepoint:canary-simulation:v1").digest("hex");

const binomial = (rng: Rng, p: number) => {
  let y = 0;
  for (let i = 0; i < N_RUNS; i++) if (rng.next() < p) y++;
  return y;
};
const shifted = (p: number, logit: number) => 1 / (1 + Math.exp(-(Math.log(p / (1 - p)) + logit)));

/** The first day a regime opens, or null when none does within the horizon. */
function firstRegimeDay(rng: Rng, shift: number): number | null {
  const ps = Array.from({ length: PROMPTS }, () => (rng.next() < 0.5 ? 0.2 : 0.5));
  const baselines = ps.map((p) => {
    const ys = Array.from({ length: BASELINE_DAYS }, () => binomial(rng, p));
    const p0 = ys.reduce((sum, y) => sum + y, 0) / (BASELINE_DAYS * N_RUNS);
    return cusumBaseline(
      ys.map((y) => empiricalLogit(y, N_RUNS)),
      p0,
    );
  });
  const states = ps.map(() => ({ up: 0, down: 0 }));
  for (let day = 1; day <= HORIZON; day++) {
    const alarms: boolean[] = [];
    ps.forEach((p, i) => {
      const baseline = baselines[i] as CusumBaseline | null;
      const y = binomial(rng, shift ? shifted(p, shift) : p);
      if (!baseline) return;
      const step = cusumStep(
        states[i] as { up: number; down: number },
        empiricalLogit(y, N_RUNS),
        baseline,
      );
      states[i] = step;
      alarms.push(step.alarm);
    });
    if (regimeAlarm(alarms)) return day;
  }
  return null;
}

test("42 baseline days and 90 in-control days open no drift regime in at least 99% of runs", () => {
  const rng = rngFromSeed(SEED);
  const runs = 400;
  let falseRegimes = 0;
  for (let r = 0; r < runs; r++) if (firstRegimeDay(rng, 0) !== null) falseRegimes++;
  console.info(`false regimes in ${HORIZON} days: ${falseRegimes} of ${runs}`);
  expect(falseRegimes / runs).toBeLessThanOrEqual(0.01);
});

test("a 0.5-logit shift on every prompt opens a regime within 8 days in at least 90% of runs", () => {
  const rng = rngFromSeed(SEED);
  const runs = 400;
  const delays = Array.from({ length: runs }, () => firstRegimeDay(rng, 0.5) ?? HORIZON + 1);
  const detected = delays.filter((d) => d <= 8).length;
  console.info(`detected within 8 days: ${detected} of ${runs}`);
  expect(detected / runs).toBeGreaterThanOrEqual(0.9);
});
