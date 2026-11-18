import { describe, expect, test } from "vitest";
import { type CaptureFrame, pairedCompare, rankWithTies } from "../src/compare";
import { seedFor } from "../src/methodology";
import { col, frameOf } from "./fixtures";

const seed = seedFor("report", "methodology");
const frame40 = frameOf(5, 8);
const frame200 = frameOf(25, 8);

// Each key starts at its own offset, so different entities are not recommended in nested captures.
const ent = (key: string, recs: number) => {
  const column = col(key, recs, { size: 200, offset: key.charCodeAt(0) - 97 });
  const value = Math.round((100 * recs) / 200);
  return { column, value, pointValue: value };
};

describe("pairedCompare", () => {
  test("criterion 8: identical columns are tied with p = 0.5 ± 0.02", () => {
    const a = col("a", 4);
    const r = pairedCompare(a, { ...col("b", 4), y: a.y, ordinal: a.ordinal }, frame40, seed);
    expect(r.verdict).toBe("tied");
    expect(Math.abs(r.pAAhead - 0.5)).toBeLessThanOrEqual(0.02);
  });

  test("criterion 8: 8 of 40 against 0 of 40 is ahead", () => {
    expect(pairedCompare(col("a", 8), col("b", 0), frame40, seed).verdict).toBe("ahead");
  });

  test("the reverse is behind and p complements", () => {
    const a = col("a", 8);
    const b = col("b", 1, { offset: 3 });
    const ab = pairedCompare(a, b, frame40, seed);
    const ba = pairedCompare(b, a, frame40, seed);
    expect(ba.verdict).toBe("behind");
    expect(Math.abs(ba.pAAhead - (1 - ab.pAAhead))).toBeLessThanOrEqual(1e-9);
  });

  test("ties inside a draw count half", () => {
    expect(pairedCompare(col("a", 0), col("b", 0), frame40, seed)).toEqual({
      pAAhead: 0.5,
      verdict: "tied",
    });
  });

  test("pairing: recommended in a strict superset of the captures is always ahead", () => {
    const a = col("a", 30, { size: 200 });
    const b = { ...col("b", 0, { size: 200 }), y: a.y.map((v, i) => (i === 0 ? 0 : v)) };
    expect(pairedCompare(a, b, frame200, seed)).toEqual({ pAAhead: 1, verdict: "ahead" });
  });

  test("a near tie stays tied", () => {
    expect(pairedCompare(col("a", 5), col("b", 4, { offset: 1 }), frame40, seed).verdict).toBe(
      "tied",
    );
  });

  test("prominence counts: same recommendations at rank 1 beat rank 10", () => {
    const top = col("a", 30, { size: 200, ordinal: 1 });
    const low = { ...col("b", 30, { size: 200, ordinal: 10 }), y: top.y };
    expect(pairedCompare(top, low, frame200, seed).verdict).toBe("ahead");
  });

  test("an unranked recommendation counts for the rate and leaves G at 1", () => {
    const unranked = col("a", 4, { ordinal: 0 });
    const ranked = { ...col("b", 4, { ordinal: 1 }), y: unranked.y };
    expect(pairedCompare(unranked, ranked, frame40, seed).pAAhead).toBe(0.5);
  });

  test("captures in a zero-weight stratum do not count", () => {
    const frame: CaptureFrame = {
      captures: frame40.captures.map((c, i) => ({ ...c, weight: i < 8 ? 0 : c.weight })),
    };
    const a = col("a", 8, { size: 40, offset: 0, ordinal: 1 });
    a.y.fill(0, 8);
    expect(pairedCompare(a, col("b", 0), frame, seed)).toEqual({ pAAhead: 0.5, verdict: "tied" });
  });

  test("rejects columns not aligned with the frame and strata with mixed weights", () => {
    expect(() => pairedCompare(col("a", 1, { size: 39 }), col("b", 1), frame40, seed)).toThrow(
      RangeError,
    );
    const mixed: CaptureFrame = {
      captures: frame40.captures.map((c, i) => ({ ...c, weight: i === 1 ? 0.5 : c.weight })),
    };
    expect(() => pairedCompare(col("a", 1), col("b", 1), mixed, seed)).toThrow(RangeError);
    const invalid: CaptureFrame = {
      captures: frame40.captures.map((c, i) => ({ ...c, weight: i === 0 ? Number.NaN : c.weight })),
    };
    expect(() => pairedCompare(col("a", 1), col("b", 1), invalid, seed)).toThrow(RangeError);
  });

  test("deterministic for the same seed", () => {
    const a = col("a", 6);
    const b = col("b", 4, { offset: 2, ordinal: 3 });
    expect(pairedCompare(a, b, frame40, seed)).toEqual(pairedCompare(a, b, frame40, seed));
  });
});

test("a frame is frozen once compared, so its cached draws can never go stale", () => {
  const frame = frameOf(5, 8);
  const first = pairedCompare(col("a", 6), col("b", 3, { offset: 1 }), frame, seed);
  expect(Object.isFrozen(frame) && Object.isFrozen(frame.captures)).toBe(true);
  expect(() => {
    (frame.captures[0] as { weight: number }).weight = 1;
  }).toThrow(TypeError);
  expect(() => frame.captures.push({ stratum: "s0", weight: 0.2 })).toThrow(TypeError);
  expect(pairedCompare(col("a", 6), col("b", 3, { offset: 1 }), frame, seed)).toEqual(first);
});

describe("rankWithTies", () => {
  test("groups tied neighbours in order", () => {
    expect(rankWithTies([ent("a", 30), ent("b", 29), ent("c", 5)], frame200, seed)).toEqual([
      ["a", "b"],
      ["c"],
    ]);
  });

  test("orders by value, then pointValue, then key", () => {
    const zero = (key: string, pointValue: number) => ({
      column: col(key, 0, { size: 200 }),
      value: 0,
      pointValue,
    });
    expect(rankWithTies([zero("b", 0), zero("c", 1), zero("a", 0)], frame200, seed)).toEqual([
      ["c", "a", "b"],
    ]);
  });

  test("separate entities each get their own group", () => {
    expect(rankWithTies([ent("c", 2), ent("a", 60), ent("b", 25)], frame200, seed)).toEqual([
      ["a"],
      ["b"],
      ["c"],
    ]);
  });

  test("empty and single inputs", () => {
    expect(rankWithTies([], frame200, seed)).toEqual([]);
    expect(rankWithTies([ent("a", 3)], frame200, seed)).toEqual([["a"]]);
  });

  test("deterministic for the same seed", () => {
    const entities = [ent("a", 30), ent("b", 26), ent("c", 22), ent("d", 5)];
    expect(rankWithTies(entities, frame200, seed)).toEqual(rankWithTies(entities, frame200, seed));
  });
});
