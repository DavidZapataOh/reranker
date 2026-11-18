import type { LevelKey, ScoreEstimate } from "@reranker/schema/measurement";
import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { engineStatus, levelDisplay, levelOf, sufficiency } from "../src/levels";

function score(overrides: Partial<ScoreEstimate> = {}): ScoreEstimate {
  return {
    value: 20,
    lower: 12,
    upper: 30,
    atMost: null,
    level: "sometimes",
    levelDisplay: { kind: "single", level: "sometimes" },
    sufficiency: "sufficient",
    preliminary: true,
    components: {
      recommendationRate: {
        estimate: 0.25,
        lower: 0.15,
        upper: 0.38,
        successes: 50,
        trials: 200,
        effectiveTrials: 200,
        designEffect: 1,
        method: "jeffreys_eff",
      },
      prominence: { estimate: 0.8, lower: 0.7, upper: 0.9, typicalPosition: 3 },
    },
    ...overrides,
  };
}

const ORDER: readonly LevelKey[] = ["invisible", "sometimes", "on_the_list", "regular"];

describe("levelOf", () => {
  test.each([
    [0, "invisible"],
    [9, "invisible"],
    [10, "sometimes"],
    [39, "sometimes"],
    [40, "on_the_list"],
    [69, "on_the_list"],
    [70, "regular"],
    [100, "regular"],
  ] as const)("levelOf(%s) = %s", (v, l) => expect(levelOf(v)).toBe(l));

  test.each([-1, 101, Number.NaN, Number.POSITIVE_INFINITY])("rejects %s", (v) =>
    expect(() => levelOf(v)).toThrow(RangeError),
  );

  test("never decreases as the score grows", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 99 }),
        (v) => ORDER.indexOf(levelOf(v + 1)) >= ORDER.indexOf(levelOf(v)),
      ),
    );
  });
});

describe("levelDisplay", () => {
  test("criterion 7", () => {
    expect(levelDisplay(38, 46)).toEqual({ kind: "between", from: "sometimes", to: "on_the_list" });
    expect(levelDisplay(3, 15)).toEqual({ kind: "between", from: "invisible", to: "sometimes" });
    expect(levelDisplay(5, 45)).toEqual({ kind: "insufficient" });
    expect(levelDisplay(12, 30)).toEqual({ kind: "single", level: "sometimes" });
  });

  test("cut points belong to the upper level", () => {
    expect(levelDisplay(10, 39)).toEqual({ kind: "single", level: "sometimes" });
    expect(levelDisplay(9, 10)).toEqual({ kind: "between", from: "invisible", to: "sometimes" });
    expect(levelDisplay(70, 100)).toEqual({ kind: "single", level: "regular" });
    expect(levelDisplay(0, 0)).toEqual({ kind: "single", level: "invisible" });
  });

  test("rejects an inverted range", () => {
    expect(() => levelDisplay(30, 12)).toThrow(RangeError);
  });

  test("names the levels of both bounds and never spans three or more", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 100 }), fc.integer({ min: 0, max: 100 }), (a, b) => {
        const [lower, upper] = a <= b ? [a, b] : [b, a];
        const span = ORDER.indexOf(levelOf(upper)) - ORDER.indexOf(levelOf(lower));
        const display = levelDisplay(lower, upper);
        if (span === 0) expect(display).toEqual({ kind: "single", level: levelOf(lower) });
        else if (span === 1)
          expect(display).toEqual({ kind: "between", from: levelOf(lower), to: levelOf(upper) });
        else expect(display).toEqual({ kind: "insufficient" });
      }),
    );
  });
});

describe("sufficiency", () => {
  test.each([
    [10, 26, "sufficient"],
    [10, 27, "orientative"],
    [10, 40, "orientative"],
    [10, 41, "insufficient"],
    [0, 0, "sufficient"],
  ] as const)("sufficiency(%s, %s) = %s", (l, u, s) => expect(sufficiency(l, u)).toBe(s));

  test("rejects an inverted or off-scale range", () => {
    expect(() => sufficiency(41, 10)).toThrow(RangeError);
    expect(() => sufficiency(-1, 10)).toThrow(RangeError);
    expect(() => sufficiency(10, Number.NaN)).toThrow(RangeError);
  });
});

describe("engineStatus", () => {
  test("is few_data when excluded or insufficient, else the level", () => {
    expect(engineStatus({ included: false }, score({ level: "sometimes" }))).toBe("few_data");
    expect(
      engineStatus({ included: true }, score({ levelDisplay: { kind: "insufficient" } })),
    ).toBe("few_data");
    expect(engineStatus({ included: true }, null)).toBe("few_data");
    expect(
      engineStatus(
        { included: true },
        score({ level: "regular", levelDisplay: { kind: "single", level: "regular" } }),
      ),
    ).toBe("regular");
  });

  test("a range between two levels still reports the level of the value", () => {
    expect(
      engineStatus(
        { included: true },
        score({
          value: 41,
          lower: 38,
          upper: 46,
          level: "on_the_list",
          levelDisplay: { kind: "between", from: "sometimes", to: "on_the_list" },
        }),
      ),
    ).toBe("on_the_list");
  });
});
