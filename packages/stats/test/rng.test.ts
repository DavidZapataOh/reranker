import { describe, expect, test } from "vitest";
import { beta, gamma, rngFromSeed } from "../src/rng";
import { draw, SEED } from "./fixtures";

describe("rngFromSeed", () => {
  test("xoshiro128** reference output", () => {
    const r = rngFromSeed(`01000000020000000300000004000000${"0".repeat(32)}`);
    expect([0, 1, 2].map(() => Math.round(r.next() * 2 ** 32))).toEqual([11520, 0, 5927040]);
  });

  test("same seed, same stream; different seed, different stream", () => {
    const a = Array.from(draw(100, (r) => r.next()));
    expect(Array.from(draw(100, (r) => r.next()))).toEqual(a);
    expect(Array.from(draw(100, (r) => r.next(), SEED.toUpperCase()))).toEqual(a);
    expect(Array.from(draw(100, (r) => r.next(), `${SEED.slice(0, 63)}9`))).toEqual(a);
    expect(Array.from(draw(100, (r) => r.next(), `0${SEED.slice(1)}`))).not.toEqual(a);
  });

  test("outputs are in [0, 1) on a 2^-32 grid", () => {
    // One assertion over the whole sample: an expect per draw cost far more than the generator.
    const offGrid = draw(10_000, (r) => r.next()).filter(
      (x) => !(x >= 0 && x < 1 && Number.isInteger(x * 2 ** 32)),
    );
    expect(Array.from(offGrid)).toEqual([]);
  });

  test("all-zero seed is rejected", () => expect(() => rngFromSeed("0".repeat(64))).toThrow());

  test.each(["", "abc", "g".repeat(64), "0".repeat(63), "0".repeat(65)])(
    "malformed seed %j is rejected",
    (seed) => expect(() => rngFromSeed(seed)).toThrow(RangeError),
  );
});

describe("samplers", () => {
  test.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])("gamma rejects shape %s", (shape) =>
    expect(() => gamma(rngFromSeed(SEED), shape)).toThrow(RangeError),
  );

  test.each([
    [0, 1],
    [1, -2],
    [Number.NaN, 1],
  ])("beta rejects parameters (%s, %s)", (a, b) =>
    expect(() => beta(rngFromSeed(SEED), a, b)).toThrow(RangeError),
  );
});
