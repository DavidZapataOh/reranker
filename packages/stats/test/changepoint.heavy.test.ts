import { describe, expect, test } from "vitest";
import { bocpdVectors, expectVector, runBocpd, UNIT_MAX_DAYS } from "./support/bocpd";

// Series long enough to fill the default window; the unit project covers the same lines with a
// small window.
describe("BOCPD over the full window", () => {
  test.each(bocpdVectors.filter((c) => c.input.ys.length > UNIT_MAX_DAYS))("vector %#", (c) =>
    expectVector(c, expect),
  );

  test("a long stable series stays at the last run length instead of resetting", () => {
    const { state, maps } = runBocpd(Array(450).fill(5), Array(450).fill(10));
    expect(maps.at(-1)).toBe(400);
    expect(state.logR).toHaveLength(401);
  });
});
