import { describe, expect, test } from "vitest";
import { dirichletStratum, drawStratifiedDirichlet } from "../src/dirichlet";
import { seedFor } from "../src/methodology";
import { rngFromSeed } from "../src/rng";

const draws = 20_000;

const total = (xs: Float64Array) => xs.reduce((a, b) => a + b, 0);

// Each member's share of its stratum is Beta(1, n − 1): mean 1/n, variance (n − 1)/(n²(n + 1)).
function moments(members: number, rest: number, seed: string) {
  const stratum = dirichletStratum(
    2,
    Array.from({ length: members }, (_, j) => j),
    rest,
  );
  const rng = rngFromSeed(seed);
  const out = new Float64Array(members);
  let sum = 0;
  let sumSq = 0;
  for (let s = 0; s < draws; s++) {
    drawStratifiedDirichlet(rng, [stratum], out);
    const share = (out[0] as number) / 2;
    sum += share;
    sumSq += share * share;
  }
  const mean = sum / draws;
  return { mean, variance: sumSq / draws - mean * mean };
}

describe("drawStratifiedDirichlet", () => {
  test("a whole stratum always sums to its weight", () => {
    const strata = [dirichletStratum(0.3, [0, 1, 2]), dirichletStratum(0.7, [3, 4, 5, 6, 7])];
    const rng = rngFromSeed(seedFor("dirichlet"));
    const out = new Float64Array(8);
    for (let s = 0; s < 100; s++) {
      drawStratifiedDirichlet(rng, strata, out);
      expect(total(out.subarray(0, 3))).toBeCloseTo(0.3, 12);
      expect(total(out.subarray(3))).toBeCloseTo(0.7, 12);
    }
  });

  test.each([
    [1, 7],
    [2, 6],
    [3, 5],
    [8, 0],
    [2, 30],
    [1, 1],
  ])("%i members with %i other trials follow the Dirichlet marginal", (members, rest) => {
    const n = members + rest;
    const m = moments(members, rest, seedFor("moments", String(members), String(rest)));
    expect(m.mean).toBeCloseTo(1 / n, 2);
    expect(Math.abs(m.variance / ((n - 1) / (n * n * (n + 1))) - 1)).toBeLessThan(0.05);
  });

  test("writes at the offset", () => {
    const out = new Float64Array(6);
    drawStratifiedDirichlet(rngFromSeed(seedFor("offset")), [dirichletStratum(1, [0, 1])], out, 4);
    expect(out[0]).toBe(0);
    expect(total(out.subarray(4))).toBeCloseTo(1, 12);
  });
});
