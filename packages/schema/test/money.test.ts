import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { CURRENCIES } from "../src/currencies";
import {
  add,
  allocate,
  compare,
  fromMajor,
  MoneySchema,
  money,
  multiplyByBps,
  subtract,
  sum,
} from "../src/money";

const arbMoney = (currency: "COP" | "USD" | "EUR") =>
  fc.integer({ min: -1_000_000_000, max: 1_000_000_000 }).map((n) => money(n, currency));

describe("currencies", () => {
  test("declares COP, USD and EUR", () => {
    expect(CURRENCIES.COP).toEqual({ exponent: 2, displayFractionDigits: 0 });
    expect(CURRENCIES.USD).toEqual({ exponent: 2, displayFractionDigits: 2 });
    expect(CURRENCIES.EUR).toEqual({ exponent: 2, displayFractionDigits: 2 });
  });
});

describe("money", () => {
  test("fromMajor parses exact decimals", () => {
    expect(fromMajor("149000", "COP")).toEqual({ amount_minor: 14_900_000, currency: "COP" });
    expect(fromMajor("149000.5", "COP").amount_minor).toBe(14_900_050);
    expect(fromMajor("-1.25", "USD").amount_minor).toBe(-125);
    expect(fromMajor("12.5", "EUR")).toEqual({ amount_minor: 1250, currency: "EUR" });
    expect(() => fromMajor("1.234", "USD")).toThrow();
    expect(() => fromMajor("1e3", "COP")).toThrow();
  });

  test("fromMajor accepts finite numbers only", () => {
    expect(fromMajor(1.25, "USD").amount_minor).toBe(125);
    expect(() => fromMajor(Number.NaN, "USD")).toThrow();
    expect(() => fromMajor(Number.POSITIVE_INFINITY, "USD")).toThrow();
  });

  test("fromMajor normalizes negative zero", () => {
    expect(fromMajor("-0.00", "USD").amount_minor).toBe(0);
    expect(Object.is(fromMajor("-0", "USD").amount_minor, 0)).toBe(true);
  });

  test("fromMajor rejects values beyond the safe integer range", () => {
    expect(() => fromMajor("99999999999999999999", "COP")).toThrow();
  });

  test("multiplyByBps applies VAT 19 %", () => {
    expect(multiplyByBps(money(14_900_000, "COP"), 1900).amount_minor).toBe(2_831_000);
    expect(multiplyByBps(money(5, "COP"), 1000).amount_minor).toBe(1);
    expect(multiplyByBps(money(5, "COP"), 1000, "down").amount_minor).toBe(0);
    expect(multiplyByBps(money(-5, "COP"), 1000).amount_minor).toBe(-1);
    expect(multiplyByBps(money(-5, "COP"), 1000, "down").amount_minor).toBe(0);
    expect(multiplyByBps(money(4, "COP"), 1000).amount_minor).toBe(0);
  });

  test("multiplyByBps does not overflow in the intermediate product", () => {
    const big = money(Number.MAX_SAFE_INTEGER, "COP");
    expect(multiplyByBps(big, 10_000)).toEqual(big);
    expect(() => multiplyByBps(big, 20_000)).toThrow();
  });

  test("multiplyByBps rejects non-integer basis points", () => {
    expect(() => multiplyByBps(money(1, "COP"), 1.5)).toThrow();
  });

  test("allocate sums exactly to the original amount", () => {
    fc.assert(
      fc.property(
        arbMoney("COP"),
        fc
          .array(fc.integer({ min: 0, max: 1000 }), { minLength: 1, maxLength: 20 })
          .filter((w) => w.some((x) => x > 0)),
        (m, w) => {
          expect(sum(allocate(m, w), "COP")).toEqual(m);
        },
      ),
    );
  });

  test("allocate gives leftover units to the largest remainders, lowest index first", () => {
    expect(allocate(money(100, "COP"), [1, 1, 1]).map((p) => p.amount_minor)).toEqual([34, 33, 33]);
    expect(allocate(money(-100, "COP"), [1, 1, 1]).map((p) => p.amount_minor)).toEqual([
      -34, -33, -33,
    ]);
    expect(allocate(money(1, "COP"), [0, 1, 1]).map((p) => p.amount_minor)).toEqual([0, 1, 0]);
  });

  test("allocate rejects invalid weights", () => {
    expect(() => allocate(money(1, "COP"), [])).toThrow();
    expect(() => allocate(money(1, "COP"), [0, 0])).toThrow();
    expect(() => allocate(money(1, "COP"), [-1, 2])).toThrow();
    expect(() => allocate(money(1, "COP"), [1.5])).toThrow();
  });

  test("add is associative and commutative", () => {
    fc.assert(
      fc.property(arbMoney("COP"), arbMoney("COP"), arbMoney("COP"), (a, b, c) => {
        expect(add(add(a, b), c)).toEqual(add(a, add(b, c)));
        expect(add(a, b)).toEqual(add(b, a));
      }),
    );
  });

  test("subtract inverts add", () => {
    fc.assert(
      fc.property(arbMoney("USD"), arbMoney("USD"), (a, b) => {
        expect(subtract(add(a, b), b)).toEqual(a);
      }),
    );
  });

  test("compare orders amounts of the same currency", () => {
    expect(compare(money(1, "COP"), money(2, "COP"))).toBe(-1);
    expect(compare(money(2, "COP"), money(2, "COP"))).toBe(0);
    expect(compare(money(3, "COP"), money(2, "COP"))).toBe(1);
    expect(() => compare(money(1, "COP"), money(1, "USD"))).toThrow();
  });

  test("mixing currencies throws", () => {
    expect(() => add(money(1, "COP"), money(1, "USD"))).toThrow();
    expect(() => subtract(money(1, "USD"), money(1, "EUR"))).toThrow();
    expect(() => sum([money(1, "COP")], "USD")).toThrow();
  });

  test("safe-integer limit", () => {
    expect(() => money(Number.MAX_SAFE_INTEGER + 1, "COP")).toThrow();
    expect(() => add(money(Number.MAX_SAFE_INTEGER, "COP"), money(1, "COP"))).toThrow();
    expect(() => money(1.5, "COP")).toThrow();
  });

  test("rejects unknown currencies at runtime", () => {
    expect(() => money(1, "GBP" as never)).toThrow();
  });

  test("sum of nothing is zero", () => {
    expect(sum([], "COP")).toEqual(money(0, "COP"));
  });

  test("MoneySchema rejects non-integers, unknown currencies and extra keys", () => {
    expect(MoneySchema.safeParse({ amount_minor: 1.5, currency: "COP" }).success).toBe(false);
    expect(MoneySchema.safeParse({ amount_minor: 1, currency: "GBP" }).success).toBe(false);
    expect(MoneySchema.safeParse({ amount_minor: 1, currency: "EUR" }).success).toBe(true);
    expect(MoneySchema.safeParse({ amount_minor: 1, currency: "COP", extra: 1 }).success).toBe(
      false,
    );
  });
});
