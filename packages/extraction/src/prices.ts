import { AppError, cost, type ProviderCost } from "@reranker/schema";
import type { StructuredResult } from "./providers/types";

/**
 * Places API (New) list price of one request per SKU, first monthly volume tier (0 to 100,000),
 * from https://developers.google.com/maps/billing-and-pricing/pricing as read on 2026-11-18.
 * Spend is reserved at list price; the monthly free usage only lowers the invoice.
 */
export const PLACES_SKU_PRICES = {
  /** Text Search Pro, 32 USD per 1,000. */
  textSearchPro: cost(32_000, "USD"),
  /** Place Details Essentials (IDs Only), unlimited and free. */
  placeDetailsIdsOnly: cost(0, "USD"),
  /** Place Details Enterprise, 20 USD per 1,000. */
  placeDetailsEnterprise: cost(20_000, "USD"),
} as const satisfies Record<string, ProviderCost>;

/** Micro-USD per 1M tokens, which is also USD per 1M tokens times 10^6. */
interface TokenRates {
  input: number;
  cachedInput: number;
  /** Write at the provider's default cache lifetime (OpenAI 30 min, Anthropic 5 min). */
  cacheWrite: number;
  output: number;
}

interface PricePeriod {
  /** ISO instant the period starts; null for prices in force since before the table was written. */
  from: string | null;
  rates: TokenRates;
  /** Prompts with more input tokens than `above` (cache reads and writes included) pay `rates`. */
  longContext?: { above: number; rates: TokenRates };
}

interface ModelPricing {
  source: string;
  readOn: string;
  periods: readonly PricePeriod[];
}

const OPENAI = "https://developers.openai.com/api/docs/pricing (Standard)";
const GEMINI = "https://ai.google.dev/gemini-api/docs/pricing (Paid Tier, Standard)";
const CLAUDE = "https://platform.claude.com/docs/en/about-claude/pricing";

// Gemini implicit caching bills no write, so a write costs what ordinary input costs.
const LLM_PRICES: Readonly<Record<string, ModelPricing>> = {
  "gpt-6-luna": {
    source: OPENAI,
    readOn: "2026-11-18",
    periods: [
      {
        from: null,
        rates: { input: 100_000, cachedInput: 10_000, cacheWrite: 125_000, output: 500_000 },
        longContext: {
          above: 272_000,
          rates: { input: 200_000, cachedInput: 20_000, cacheWrite: 250_000, output: 750_000 },
        },
      },
    ],
  },
  "gpt-6.1-terra": {
    source: OPENAI,
    readOn: "2026-11-18",
    periods: [
      {
        from: null,
        rates: { input: 1_000_000, cachedInput: 50_000, cacheWrite: 1_250_000, output: 5_000_000 },
        longContext: {
          above: 272_000,
          rates: {
            input: 2_000_000,
            cachedInput: 100_000,
            cacheWrite: 2_500_000,
            output: 7_500_000,
          },
        },
      },
    ],
  },
  "gemini-3.1-flash-lite": {
    source: GEMINI,
    readOn: "2026-11-18",
    periods: [
      {
        from: null,
        rates: { input: 250_000, cachedInput: 25_000, cacheWrite: 250_000, output: 1_500_000 },
      },
    ],
  },
  "gemini-3.8-flash": {
    source: GEMINI,
    readOn: "2026-11-18",
    periods: [
      {
        from: null,
        rates: { input: 750_000, cachedInput: 75_000, cacheWrite: 750_000, output: 3_750_000 },
      },
      {
        // "Through December 31, 2026": Google bills in Pacific time.
        from: "2027-01-01T00:00:00-08:00",
        rates: { input: 1_500_000, cachedInput: 150_000, cacheWrite: 1_500_000, output: 7_500_000 },
      },
    ],
  },
  "claude-haiku-5-5": {
    source: CLAUDE,
    readOn: "2026-11-18",
    periods: [
      {
        from: null,
        rates: { input: 100_000, cachedInput: 10_000, cacheWrite: 125_000, output: 500_000 },
        longContext: {
          above: 100_000,
          rates: { input: 500_000, cachedInput: 50_000, cacheWrite: 625_000, output: 2_500_000 },
        },
      },
    ],
  },
  "claude-sonnet-5-5": {
    source: CLAUDE,
    readOn: "2026-11-18",
    periods: [
      {
        from: null,
        rates: {
          input: 2_000_000,
          cachedInput: 100_000,
          cacheWrite: 2_500_000,
          output: 10_000_000,
        },
      },
    ],
  },
};

const TOKENS_PER_UNIT = 1_000_000;

function ratesFor(model: string, inputTokens: number, at: Date): TokenRates {
  const pricing = LLM_PRICES[model];
  if (!pricing) {
    // A model without a price would reserve nothing and spend without a cap.
    throw new AppError("internal", { detail: `No token price for model ${model}` });
  }
  const period = pricing.periods.findLast((p) => p.from === null || Date.parse(p.from) <= +at);
  if (!period) throw new AppError("internal", { detail: `No price in force for model ${model}` });
  const long = period.longContext;
  return long && inputTokens > long.above ? long.rates : period.rates;
}

/** What a finished call cost, rounded up to the micro-USD. */
export function costOfUsage(
  model: string,
  usage: StructuredResult<unknown>["usage"],
  at: Date = new Date(),
): ProviderCost {
  const rates = ratesFor(model, usage.inputTokens, at);
  const uncached = usage.inputTokens - usage.cachedInputTokens - usage.cacheWriteTokens;
  const scaled =
    uncached * rates.input +
    usage.cachedInputTokens * rates.cachedInput +
    usage.cacheWriteTokens * rates.cacheWrite +
    usage.outputTokens * rates.output;
  return cost(Math.ceil(scaled / TOKENS_PER_UNIT), "USD");
}

/** Reservation for a call before it runs: every input token priced at its dearest rate. */
export function estimateOf(
  model: string,
  inputTokens: number,
  outputTokens: number,
  at: Date = new Date(),
): ProviderCost {
  const rates = ratesFor(model, inputTokens, at);
  const scaled =
    inputTokens * Math.max(rates.input, rates.cacheWrite) + outputTokens * rates.output;
  return cost(Math.ceil(scaled / TOKENS_PER_UNIT), "USD");
}
