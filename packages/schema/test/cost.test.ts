import fc from "fast-check";
import { describe, expect, test } from "vitest";
import {
  addCost,
  compareCost,
  cost,
  costFromMajor,
  ProviderCostSchema,
  sumCosts,
} from "../src/cost";

describe("provider cost", () => {
  test("costs in micro-units", () => {
    expect(costFromMajor("0.0012", "USD")).toEqual({ amount_micros: 1_200, currency: "USD" });
    expect(
      sumCosts(
        Array.from({ length: 150 }, () => costFromMajor("0.004", "USD")),
        "USD",
      ).amount_micros,
    ).toBe(600_000);
    expect(cost(0, "USD").amount_micros).toBe(0);
    expect(() => costFromMajor("0.0000001", "USD")).toThrow();
    expect(() => cost(-1, "USD")).toThrow();
  });

  test("costFromMajor rejects negatives, malformed input and unsafe magnitudes", () => {
    expect(() => costFromMajor("-0.5", "USD")).toThrow();
    expect(() => costFromMajor("1e3", "USD")).toThrow();
    expect(() => costFromMajor(Number.NaN, "USD")).toThrow();
    expect(costFromMajor(0.5, "EUR")).toEqual({ amount_micros: 500_000, currency: "EUR" });
    expect(() => costFromMajor("99999999999999999999", "USD")).toThrow();
  });

  test("cost rejects non-integers and unknown currencies", () => {
    expect(() => cost(1.5, "USD")).toThrow();
    expect(() => cost(1, "GBP" as never)).toThrow();
  });

  test("addCost is associative and commutative and rejects mixed currencies", () => {
    const arb = fc.integer({ min: 0, max: 1_000_000_000 }).map((n) => cost(n, "COP"));
    fc.assert(
      fc.property(arb, arb, arb, (a, b, c) => {
        expect(addCost(addCost(a, b), c)).toEqual(addCost(a, addCost(b, c)));
        expect(addCost(a, b)).toEqual(addCost(b, a));
      }),
    );
    expect(() => addCost(cost(1, "COP"), cost(1, "USD"))).toThrow();
    expect(() => addCost(cost(Number.MAX_SAFE_INTEGER, "USD"), cost(1, "USD"))).toThrow();
  });

  test("sumCosts of nothing is zero and checks the currency", () => {
    expect(sumCosts([], "USD")).toEqual(cost(0, "USD"));
    expect(() => sumCosts([cost(1, "COP")], "USD")).toThrow();
  });

  test("compareCost orders costs of the same currency", () => {
    expect(compareCost(cost(1, "USD"), cost(2, "USD"))).toBe(-1);
    expect(compareCost(cost(2, "USD"), cost(2, "USD"))).toBe(0);
    expect(compareCost(cost(3, "USD"), cost(2, "USD"))).toBe(1);
    expect(() => compareCost(cost(1, "USD"), cost(1, "EUR"))).toThrow();
  });

  test("ProviderCostSchema rejects negatives, fractions and extra keys", () => {
    expect(ProviderCostSchema.safeParse({ amount_micros: 1, currency: "USD" }).success).toBe(true);
    expect(ProviderCostSchema.safeParse({ amount_micros: -1, currency: "USD" }).success).toBe(
      false,
    );
    expect(ProviderCostSchema.safeParse({ amount_micros: 0.5, currency: "USD" }).success).toBe(
      false,
    );
    expect(
      ProviderCostSchema.safeParse({ amount_micros: 1, currency: "USD", extra: 1 }).success,
    ).toBe(false);
  });
});
