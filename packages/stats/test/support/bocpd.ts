import { readFileSync } from "node:fs";
import { type BocpdOptions, type BocpdState, bocpdInit, bocpdStep } from "../../src/changepoint";

export type BocpdCase = {
  input: { ys: number[]; ns: number[] };
  output: { mapRunLengths: number[]; finalLogR: number[] };
};

export const bocpdVectors: BocpdCase[] = JSON.parse(
  readFileSync(new URL("../../test-vectors/changepoint/bocpd.json", import.meta.url), "utf8"),
).cases;

// Past this many days a series reaches the default 400-day window, and every step then works on
// all 401 run lengths: about a second under coverage, several on a shared CI runner.
export const UNIT_MAX_DAYS = 200;

export function runBocpd(ys: readonly number[], ns: readonly number[], opts?: BocpdOptions) {
  let state: BocpdState = bocpdInit();
  const maps: number[] = [];
  ys.forEach((y, t) => {
    const step = bocpdStep(state, y, ns[t] as number, opts);
    state = step.state;
    maps.push(step.mapRunLength);
  });
  return { state, maps };
}

export function expectVector({ input, output }: BocpdCase, expect: typeof import("vitest").expect) {
  const { state, maps } = runBocpd(input.ys, input.ns);
  expect(maps).toEqual(output.mapRunLengths);
  expect(state.logR).toHaveLength(output.finalLogR.length);
  state.logR.forEach((v, r) => {
    expect(v).toBeCloseTo(output.finalLogR[r] as number, 8);
  });
}
