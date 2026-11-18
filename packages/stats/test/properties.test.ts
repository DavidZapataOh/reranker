import fc from "fast-check";
import { describe, test, vi } from "vitest";
import { pairedCompare } from "../src/compare";
import { estimateScore, pointScore } from "../src/score";
import { col, frameOf, hexSeed, obs } from "./fixtures";

// These invariants hold by construction for any number of draws. Under coverage instrumentation a
// 4,000-draw case costs ~40 ms, so hundreds of them outran a loaded CI runner; score.test.ts and
// compare.test.ts keep exercising the published draw count.
vi.mock("../src/methodology", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/methodology")>();
  return { ...actual, methodology: { ...actual.methodology, mcDraws: 100 } };
});

const ordinal = fc.option(fc.integer({ min: 1, max: 20 }), { nil: null });

// Up to five strata, each a run of captures with a shared weight; at least one stratum carries weight.
function arbObservations(ordinals: fc.Arbitrary<number | null> = ordinal) {
  return fc
    .array(
      fc.record({
        weight: fc.double({ min: 0.01, max: 5, noNaN: true }),
        cells: fc.array(fc.option(ordinals, { nil: undefined }), { minLength: 1, maxLength: 40 }),
      }),
      { minLength: 1, maxLength: 5 },
    )
    .map((strata) =>
      strata.flatMap(({ weight, cells }, h) =>
        cells.map((cell, i) =>
          obs({
            captureIndex: h * 40 + i,
            stratum: `s${h}`,
            weight,
            y: cell === undefined ? 0 : 1,
            ordinal: cell === undefined ? null : cell,
          }),
        ),
      ),
    );
}

describe("estimateScore", () => {
  test("property: lower ≤ value ≤ upper, all integers in [0, 100]", () =>
    fc.assert(
      fc.property(arbObservations(), hexSeed, (o, sd) => {
        const s = estimateScore(o, sd);
        return (
          [s.lower, s.value, s.upper].every(Number.isInteger) &&
          0 <= s.lower &&
          s.lower <= s.value &&
          s.value <= s.upper &&
          s.upper <= 100 &&
          s.components.prominence.lower <= s.components.prominence.estimate &&
          s.components.prominence.estimate <= s.components.prominence.upper
        );
      }),
    ));

  test("property: one more recommendation never lowers the value", () =>
    fc.assert(
      fc.property(
        // Without unranked recommendations p̂·Ĝ is a weighted sum of discounts, monotone at any rank.
        arbObservations(fc.integer({ min: 1, max: 20 })),
        fc.nat(),
        fc.integer({ min: 1, max: 20 }),
        (o, pick, rank) => {
          const free = o.filter((x) => x.y === 0);
          const target = free[pick % Math.max(free.length, 1)];
          if (target === undefined) return true;
          const more = o.map((x) => (x === target ? { ...x, y: 1 as const, ordinal: rank } : x));
          return pointScore(more) >= pointScore(o);
        },
      ),
    ));

  test("property: a top-ranked or unranked recommendation never lowers the value", () =>
    fc.assert(
      fc.property(arbObservations(), fc.nat(), fc.constantFrom(1, null), (o, pick, rank) => {
        const free = o.filter((x) => x.y === 0);
        const target = free[pick % Math.max(free.length, 1)];
        if (target === undefined) return true;
        const more = o.map((x) => (x === target ? { ...x, y: 1 as const, ordinal: rank } : x));
        return pointScore(more) >= pointScore(o);
      }),
    ));
});

describe("pairedCompare", () => {
  const frame40 = frameOf(5, 8);

  test("property: p is a probability, complements on swap and matches the verdict", () =>
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 40 }),
        fc.integer({ min: 0, max: 40 }),
        fc.integer({ min: 0, max: 39 }),
        fc.integer({ min: 0, max: 12 }),
        hexSeed,
        (ra, rb, offset, ordinal, s) => {
          const a = col("a", ra, { ordinal });
          const b = col("b", rb, { offset, ordinal: 12 - ordinal });
          const ab = pairedCompare(a, b, frame40, s);
          const ba = pairedCompare(b, a, frame40, s);
          const expected =
            ab.pAAhead >= 0.8 ? "ahead" : ab.pAAhead <= 0.2 ? "behind" : ("tied" as const);
          return (
            ab.pAAhead >= 0 &&
            ab.pAAhead <= 1 &&
            Math.abs(ab.pAAhead + ba.pAAhead - 1) <= 1e-9 &&
            ab.verdict === expected
          );
        },
      ),
      { numRuns: 60 },
    ));
});
