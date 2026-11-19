import { describe, expect, test } from "vitest";
import { costOfUsage, estimateOf } from "../src/prices";

const usage = (over: Partial<Parameters<typeof costOfUsage>[1]> = {}) => ({
  inputTokens: 0,
  cachedInputTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 0,
  ...over,
});

describe("costOfUsage", () => {
  test("cost of a luna call with prompt caching", () =>
    // 500 × 0.10 + 1,000 × 0.01 + 300 × 0.50 micro-USD.
    expect(
      costOfUsage(
        "gpt-6-luna",
        usage({ inputTokens: 1500, cachedInputTokens: 1000, outputTokens: 300 }),
      ).amount_micros,
    ).toBe(210));

  test("cache writes are billed at the write rate, not on top of input", () =>
    // 500 × 0.10 + 1,000 × 0.125 + 300 × 0.50.
    expect(
      costOfUsage(
        "gpt-6-luna",
        usage({ inputTokens: 1500, cacheWriteTokens: 1000, outputTokens: 300 }),
      ).amount_micros,
    ).toBe(325));

  test("terra reads the cache at 0.05× input", () =>
    // 500 × 1 + 1,000 × 0.05 + 300 × 5.
    expect(
      costOfUsage(
        "gpt-6.1-terra",
        usage({ inputTokens: 1500, cachedInputTokens: 1000, outputTokens: 300 }),
      ).amount_micros,
    ).toBe(2050));

  test("fractions of a micro-USD round up", () =>
    expect(costOfUsage("gpt-6-luna", usage({ inputTokens: 1 })).amount_micros).toBe(1));

  test("prices are in USD", () =>
    expect(costOfUsage("gemini-3.1-flash-lite", usage({ inputTokens: 4 })).currency).toBe("USD"));

  test("Haiku over 100,000 prompt tokens pays the long-context price for the whole request", () => {
    expect(
      costOfUsage("claude-haiku-5-5", usage({ inputTokens: 100_000, outputTokens: 1000 }))
        .amount_micros,
    ).toBe(10_500);
    expect(
      costOfUsage(
        "claude-haiku-5-5",
        usage({ inputTokens: 100_001, cachedInputTokens: 100_000, outputTokens: 1000 }),
      ).amount_micros,
    ).toBe(7501);
  });

  test("gemini-3.8-flash doubles on 1 January 2027, Pacific time", () => {
    const call = usage({ inputTokens: 1000, outputTokens: 1000 });
    expect(
      costOfUsage("gemini-3.8-flash", call, new Date("2027-01-01T07:59:59Z")).amount_micros,
    ).toBe(4500);
    expect(
      costOfUsage("gemini-3.8-flash", call, new Date("2027-01-01T08:00:00Z")).amount_micros,
    ).toBe(9000);
  });

  test("an unpriced model fails instead of costing nothing", () =>
    expect(() => costOfUsage("gpt-unknown", usage())).toThrow(/No token price/));
});

describe("estimateOf", () => {
  test("reserves every input token at the cache-write rate when it is the dearest", () =>
    // 1,500 × 0.125 + 300 × 0.50.
    expect(estimateOf("gpt-6-luna", 1500, 300).amount_micros).toBe(338));

  test("is never below the cost of the same call", () => {
    for (const model of ["gpt-6-luna", "gemini-3.1-flash-lite", "claude-sonnet-5-5"]) {
      const spent = costOfUsage(
        model,
        usage({ inputTokens: 2000, cacheWriteTokens: 2000, outputTokens: 400 }),
      );
      expect(estimateOf(model, 2000, 400).amount_micros).toBeGreaterThanOrEqual(
        spent.amount_micros,
      );
    }
  });
});
