import { expect, test } from "vitest";
import { parseScaled } from "../src/decimal";
import { AppError } from "../src/errors";

test("parseScaled reads exact decimals", () => {
  expect(parseScaled("-12.5", 2)).toBe(-1250n);
  expect(parseScaled(3, 6)).toBe(3_000_000n);
});

test("parseScaled rejects inputs too long to be a safe amount before building a BigInt", () => {
  const long = "1".repeat(33);
  expect(() => parseScaled(long, 2)).toThrow(AppError);
  expect(() => parseScaled(long, 2)).toThrow(/too long/);
  expect(() => parseScaled(`0.${"0".repeat(10_000)}1`, 6)).toThrow(/too long/);
  expect(parseScaled("9007199254740.991", 3)).toBe(9_007_199_254_740_991n);
});
