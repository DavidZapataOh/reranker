import { describe, expect, test } from "vitest";
import { pairedCompare } from "../src/compare";
import { jeffreys } from "../src/interval";
import { levelDisplay, levelOf, sufficiency } from "../src/levels";
import { seedFor } from "../src/methodology";
import { type EntityObservation, estimateScore, pointScore } from "../src/score";
import { obs } from "./fixtures";

const seed = seedFor("report", "entity");

const rec = (over: Partial<EntityObservation> = {}) => obs({ y: 1, ...over });

function noRecs(n: number): EntityObservation[] {
  return Array.from({ length: n }, (_, captureIndex) => obs({ captureIndex }));
}

// n captures in one stratum; the first ordinals.length are recommendations at those ranks.
function recs(n: number, ordinals: readonly number[]): EntityObservation[] {
  return noRecs(n).map((o, i) =>
    i < ordinals.length ? { ...o, y: 1, ordinal: ordinals[i] ?? null } : o,
  );
}

describe("estimateScore", () => {
  test("criterion 3: zero recommendations", () => {
    const s = estimateScore(noRecs(200), seed);
    const upper = Math.ceil(100 * jeffreys(0, 200).upper);
    expect(upper).toBe(2);
    expect(s).toMatchObject({ value: 0, lower: 0, upper, atMost: upper });
    expect(s.components.prominence).toEqual({
      estimate: 1,
      lower: 1,
      upper: 1,
      typicalPosition: null,
    });
  });

  test('0 of 40 gives "a lo sumo 7"', () => {
    expect(estimateScore(noRecs(40), seed).atMost).toBe(Math.ceil(100 * 0.0604979752));
    expect(estimateScore(noRecs(40), seed).atMost).toBe(7);
  });

  test("central value is round(100·p̂·Ĝ) with Ĝ the mean of 0.9^(ordinal−1)", () => {
    const s = estimateScore(recs(200, [1, 1, 2, 3]), seed);
    const g = (1 + 1 + 0.9 + 0.81) / 4;
    expect(s.value).toBe(Math.round(100 * (4 / 200) * g));
    expect(s.atMost).toBeNull();
    expect(s.components.prominence.estimate).toBeCloseTo(g, 12);
    expect(s.components.prominence.typicalPosition).toBe(2);
  });

  test("Ĝ weighs each recommendation by its stratum weight over the stratum size", () => {
    const a = recs(10, [1]).map((o) => ({ ...o, stratum: "a", weight: 3 }));
    const b = recs(20, [3]).map((o) => ({
      ...o,
      stratum: "b",
      weight: 1,
      captureIndex: o.captureIndex + 10,
    }));
    const s = estimateScore([...a, ...b], seed);
    const g = ((3 / 10) * 1 + (1 / 20) * 0.81) / (3 / 10 + 1 / 20);
    expect(s.components.prominence.estimate).toBeCloseTo(g, 12);
    expect(s.value).toBe(Math.round(100 * ((3 * (1 / 10) + 1 * (1 / 20)) / 4) * g));
  });

  test("the range comes from the Monte Carlo draws and is wider than a point", () => {
    const s = estimateScore(recs(40, [1, 2, 4, 6, 9, 1, 3, 2]), seed);
    expect(s.lower).toBeLessThan(s.value);
    expect(s.upper).toBeGreaterThan(s.value);
    const { prominence } = s.components;
    expect(prominence.lower).toBeLessThan(prominence.estimate);
    expect(prominence.upper).toBeGreaterThan(prominence.estimate);
    expect(prominence.upper).toBeLessThanOrEqual(1);
  });

  test("pointScore matches the central value without sampling", () => {
    const o = recs(40, [1, 5, 2]);
    expect(pointScore(o)).toBe(estimateScore(o, seed).value);
    expect(pointScore(noRecs(40))).toBe(0);
  });

  test("same seed, identical output; another seed may move only the bounds", () => {
    const o = recs(40, [1, 2, 4, 6, 9, 1, 3]);
    const a = estimateScore(o, seed);
    expect(JSON.stringify(estimateScore(o, seed))).toBe(JSON.stringify(a));
    const b = estimateScore(o, seedFor("report", "other"));
    expect(b.value).toBe(a.value);
    expect(b.components.recommendationRate).toEqual(a.components.recommendationRate);
    expect(b.components.prominence.estimate).toBe(a.components.prominence.estimate);
    expect(b.components.prominence.typicalPosition).toBe(a.components.prominence.typicalPosition);
  });

  test("a recommendation with a null ordinal counts for the rate only", () => {
    const s = estimateScore([...recs(40, [1]), rec({ captureIndex: 40, ordinal: null })], seed);
    expect(s.components.recommendationRate.successes).toBe(2);
    expect(s.components.prominence).toMatchObject({
      estimate: 1,
      lower: 1,
      upper: 1,
      typicalPosition: 1,
    });
  });

  test("recommendations without any ordinal leave Ĝ at 1 with no implied rank", () => {
    const s = estimateScore([...noRecs(40), rec({ captureIndex: 40 })], seed);
    expect(s.components.prominence).toEqual({
      estimate: 1,
      lower: 1,
      upper: 1,
      typicalPosition: null,
    });
    expect(s.value).toBe(Math.round(100 / 41));
    expect(Number.isFinite(s.lower) && Number.isFinite(s.upper)).toBe(true);
  });

  test("level, levelDisplay, sufficiency and preliminary come from the rounded bounds", () => {
    const o = recs(40, [1, 1, 2, 1, 3, 1, 2, 1, 1, 4, 1, 2]);
    const s = estimateScore(o, seed);
    expect(s.level).toBe(levelOf(s.value));
    expect(s.levelDisplay).toEqual(levelDisplay(s.lower, s.upper));
    expect(s.sufficiency).toBe(sufficiency(s.lower, s.upper));
    expect(s.preliminary).toBe(true);
    expect(estimateScore(o, seed, { preliminary: false }).preliminary).toBe(false);
  });

  test("runsPerVariant widens the range through the design effect", () => {
    const o = recs(40, [1, 2, 1, 3, 1, 2, 1, 1]);
    const one = estimateScore(o, seed);
    const three = estimateScore(o, seed, { runsPerVariant: 3 });
    expect(three.components.recommendationRate.effectiveTrials).toBeLessThan(
      one.components.recommendationRate.effectiveTrials,
    );
    expect(three.upper - three.lower).toBeGreaterThanOrEqual(one.upper - one.lower);
  });

  test("a stratum whose observations disagree on its weight is rejected", () => {
    expect(() =>
      estimateScore([obs({ weight: 1 }), obs({ weight: 2, captureIndex: 1 })], seed),
    ).toThrow(RangeError);
  });

  test("a weightless stratum leaves both the rate and Ĝ", () => {
    const kept = recs(40, [1, 2]);
    const dropped = recs(10, [9, 9, 9]).map((o) => ({
      ...o,
      stratum: "zero",
      weight: 0,
      captureIndex: o.captureIndex + 40,
    }));
    const s = estimateScore([...kept, ...dropped], seed);
    expect(s.components.prominence.estimate).toBeCloseTo((1 + 0.9) / 2, 12);
    expect(s.components.recommendationRate.trials).toBe(40);
  });

  test("the G bootstrap keeps each stratum's mass at its weight, as pairedCompare does", () => {
    // Every trial of each stratum is ranked, so with weights normalized inside the stratum each
    // draw gives both strata exactly their weight and G cannot move. In a paired comparison on
    // the same frame, all of stratum a then beats 7 of the 8 captures of stratum b in every draw.
    const a = recs(8, Array(8).fill(1)).map((o) => ({ ...o, stratum: "a", weight: 0.5 }));
    const b = recs(8, Array(8).fill(3)).map((o) => ({
      ...o,
      stratum: "b",
      weight: 0.5,
      captureIndex: o.captureIndex + 8,
    }));
    const g = (1 + 0.81) / 2;
    const { prominence } = estimateScore([...a, ...b], seed).components;
    expect(prominence.estimate).toBeCloseTo(g, 12);
    expect(prominence.lower).toBeCloseTo(g, 12);
    expect(prominence.upper).toBeCloseTo(g, 12);

    const frame = { captures: [...a, ...b].map(({ stratum, weight }) => ({ stratum, weight })) };
    const column = (key: string, from: number, to: number) => {
      const y = new Uint8Array(16).fill(1, from, to);
      return { key, y, ordinal: Int16Array.from(y) };
    };
    expect(pairedCompare(column("a", 0, 8), column("b", 8, 15), frame, seed).pAAhead).toBe(1);
  });
});

describe("estimateScore on the report's shared bootstrap", () => {
  const reportSeed = seedFor("report");
  // 25 strata of 8 captures with equal weights, as in the free report.
  const frameOf = () => ({
    captures: Array.from({ length: 200 }, (_, i) => ({
      stratum: `s${Math.floor(i / 8)}`,
      weight: 1 / 25,
    })),
  });
  const entity = (recommended: number, offset: number): EntityObservation[] =>
    frameOf().captures.map(({ stratum, weight }, captureIndex) => {
      const r = (captureIndex - offset + 200) % 7 === 0 ? (captureIndex - offset) / 7 : -1;
      const y = r >= 0 && r < recommended ? 1 : 0;
      return obs({ captureIndex, stratum, weight, y, ordinal: y === 1 ? 1 + (r % 5) : null });
    });

  test("matches the standalone estimate up to Monte Carlo noise", () => {
    const e = entity(40, 0);
    const alone = estimateScore(e, seed);
    const shared = estimateScore(e, seed, { bootstrap: { frame: frameOf(), seed: reportSeed } });
    expect(shared.value).toBe(alone.value);
    expect(shared.components.prominence.estimate).toBe(alone.components.prominence.estimate);
    expect(Math.abs(shared.lower - alone.lower)).toBeLessThanOrEqual(1);
    expect(Math.abs(shared.upper - alone.upper)).toBeLessThanOrEqual(1);
    const g = (x: typeof alone) => x.components.prominence;
    expect(Math.abs(g(shared).lower - g(alone).lower)).toBeLessThan(0.01);
    expect(Math.abs(g(shared).upper - g(alone).upper)).toBeLessThan(0.01);
  });

  test("reads the same draws as pairedCompare, whichever runs first", () => {
    const e = entity(30, 2);
    const column = {
      key: "e",
      y: Uint8Array.from(e, (o) => o.y),
      ordinal: Int16Array.from(e, (o) => o.ordinal ?? 0),
    };
    const other = { ...column, key: "o", y: new Uint8Array(200) };
    const first = frameOf();
    const scoreFirst = estimateScore(e, seed, { bootstrap: { frame: first, seed: reportSeed } });
    pairedCompare(column, other, first, reportSeed);
    const second = frameOf();
    pairedCompare(column, other, second, reportSeed);
    expect(estimateScore(e, seed, { bootstrap: { frame: second, seed: reportSeed } })).toEqual(
      scoreFirst,
    );
    expect(Object.isFrozen(first)).toBe(true);
  });

  test("whole ranked strata keep G fixed on the shared draws too", () => {
    const e = frameOf().captures.map(({ stratum, weight }, captureIndex) =>
      obs({ captureIndex, stratum, weight, y: 1, ordinal: captureIndex < 8 ? 1 : 3 }),
    );
    const g = (1 / 25 + (24 / 25) * 0.81) / 1;
    const { prominence } = estimateScore(e, seed, {
      bootstrap: { frame: frameOf(), seed: reportSeed },
    }).components;
    expect(prominence.lower).toBeCloseTo(g, 12);
    expect(prominence.upper).toBeCloseTo(g, 12);
  });

  test("rejects observations that do not line up with the frame", () => {
    const e = entity(10, 0);
    const bootstrap = { frame: frameOf(), seed: reportSeed };
    expect(() =>
      estimateScore([{ ...e[0], captureIndex: 200 } as EntityObservation], seed, { bootstrap }),
    ).toThrow(RangeError);
    expect(() =>
      estimateScore(
        e.map((o) => ({ ...o, stratum: "x" })),
        seed,
        { bootstrap },
      ),
    ).toThrow(RangeError);
    expect(() =>
      estimateScore(
        e.map((o) => ({ ...o, weight: 1 })),
        seed,
        { bootstrap },
      ),
    ).toThrow(RangeError);
  });
});
