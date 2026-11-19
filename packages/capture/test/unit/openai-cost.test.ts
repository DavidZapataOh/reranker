import { InvalidInputError } from "@reranker/jobs";
import type { ResponseUsage } from "openai/resources/responses/responses";
import { expect, test } from "vitest";
import { CONTROL_RESERVE, costFromUsage } from "../../src/openai/cost";
import { OPENAI_PRICING } from "../../src/pricing/openai";

const PRICE = OPENAI_PRICING.models["gpt-6.1-terra"];

function usage(t: {
  input: number;
  cached: number;
  output: number;
  reasoning?: number;
  write?: number;
  write12h?: number;
}): ResponseUsage {
  const write = t.write ?? 0;
  return {
    input_tokens: t.input,
    input_tokens_details: {
      cached_tokens: t.cached,
      cache_write_tokens: write,
      ...(t.write12h === undefined
        ? {}
        : {
            cache_write_tokens_details: {
              ttl_12h_tokens: t.write12h,
              ttl_30m_tokens: write - t.write12h,
            },
          }),
    },
    output_tokens: t.output,
    output_tokens_details: { reasoning_tokens: t.reasoning ?? 0 },
    total_tokens: t.input + t.output,
  };
}

test("the table carries its source and the date it was read", () => {
  expect(OPENAI_PRICING.source).toBe("https://developers.openai.com/api/docs/pricing");
  expect(OPENAI_PRICING.readAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  expect(PRICE).toMatchObject({ inPerM: 1, outPerM: 5 });
  expect(OPENAI_PRICING.webSearchPerCallUsd).toBe(0.01);
});

test("input, cached, output and one search add up in micros", () =>
  expect(
    costFromUsage(usage({ input: 12_000, cached: 2_000, output: 800 }), 1, "gpt-6.1-terra"),
  ).toEqual({
    amount_micros: Math.round(10_000 + 2_000 * PRICE.cachedInPerM + 4_000 + 10_000),
    currency: "USD",
  }));

test("reasoning tokens are part of output tokens and are not counted twice", () => {
  const withReasoning = usage({ input: 1_000, cached: 0, output: 900, reasoning: 600 });
  expect(costFromUsage(withReasoning, 0, "gpt-6.1-terra").amount_micros).toBe(1_000 + 4_500);
});

test("cache writes are priced at the write rate of their lifetime, not on top of input", () => {
  const thirtyMinutes = usage({ input: 10_000, cached: 0, output: 0, write: 4_000 });
  expect(costFromUsage(thirtyMinutes, 0, "gpt-6.1-terra").amount_micros).toBe(
    Math.round(6_000 * PRICE.inPerM + 4_000 * PRICE.cacheWrite30mPerM),
  );
  const mixed = usage({ input: 10_000, cached: 0, output: 0, write: 4_000, write12h: 1_000 });
  expect(costFromUsage(mixed, 0, "gpt-6.1-terra").amount_micros).toBe(
    Math.round(
      6_000 * PRICE.inPerM + 3_000 * PRICE.cacheWrite30mPerM + 1_000 * PRICE.cacheWrite12hPerM,
    ),
  );
});

test("a prompt above the long-context threshold pays the long rates for the whole request", () => {
  const long = PRICE.longContext;
  const tokens = long.aboveInputTokens + 1;
  expect(
    costFromUsage(usage({ input: tokens, cached: 0, output: 1_000 }), 2, "gpt-6.1-terra"),
  ).toEqual({
    amount_micros: Math.round(tokens * long.inPerM + 1_000 * long.outPerM + 20_000),
    currency: "USD",
  });
  expect(
    costFromUsage(usage({ input: long.aboveInputTokens, cached: 0, output: 0 }), 0, "gpt-6.1-terra")
      .amount_micros,
  ).toBe(long.aboveInputTokens * PRICE.inPerM);
});

test("a dated snapshot without its own row is priced as its model", () =>
  expect(
    costFromUsage(usage({ input: 1_000, cached: 0, output: 100 }), 1, "gpt-6.1-terra-2026-10-01"),
  ).toEqual(costFromUsage(usage({ input: 1_000, cached: 0, output: 100 }), 1, "gpt-6.1-terra")));

test("a model missing from the table is refused, never guessed", () => {
  expect(() => costFromUsage(usage({ input: 1, cached: 0, output: 1 }), 0, "gpt-unknown")).toThrow(
    InvalidInputError,
  );
  expect(() =>
    costFromUsage(usage({ input: 1, cached: 0, output: 1 }), 0, "gpt-unknown-2026-10-01"),
  ).toThrow(InvalidInputError);
});

test("usage that cannot be billed is refused", () => {
  expect(() =>
    costFromUsage(usage({ input: 10, cached: 8, output: 0, write: 8 }), 0, "gpt-6.1-terra"),
  ).toThrow(InvalidInputError);
  expect(() =>
    costFromUsage(usage({ input: 10, cached: 0, output: 0 }), -1, "gpt-6.1-terra"),
  ).toThrow(InvalidInputError);
  expect(() =>
    costFromUsage(usage({ input: 10, cached: 0, output: 0 }), 1.5, "gpt-6.1-terra"),
  ).toThrow(InvalidInputError);
});

test("the reserve per control call is five US cents", () =>
  expect(CONTROL_RESERVE).toEqual({ amount_micros: 50_000, currency: "USD" }));

// Enabled with the recorded contract response of the control client.
test.todo("the recorded real usage costs between US$0.005 and US$0.08");
