/** USD per 1M tokens, which is also micro-USD per token. */
export interface OpenAITokenRates {
  inPerM: number;
  cachedInPerM: number;
  /** Write rate for the default 30-minute cache lifetime; a write replaces the input rate. */
  cacheWrite30mPerM: number;
  cacheWrite12hPerM: number;
  outPerM: number;
}

export interface OpenAIModelPricing extends OpenAITokenRates {
  /** Prompts with more input tokens than `aboveInputTokens` pay these rates for the whole request. */
  longContext: OpenAITokenRates & { aboveInputTokens: number };
}

/**
 * Standard-tier list prices, keyed by the model name the pricing page lists. A dated snapshot
 * gets its own row only when the page prices it apart from its model.
 */
export const OPENAI_PRICING = {
  source: "https://developers.openai.com/api/docs/pricing",
  readAt: "2026-11-19",
  models: {
    "gpt-6.1-terra": {
      inPerM: 1,
      cachedInPerM: 0.05,
      cacheWrite30mPerM: 1.25,
      cacheWrite12hPerM: 2.5,
      outPerM: 5,
      longContext: {
        aboveInputTokens: 272_000,
        inPerM: 2,
        cachedInPerM: 0.1,
        cacheWrite30mPerM: 2.5,
        cacheWrite12hPerM: 5,
        outPerM: 7.5,
      },
    },
  } satisfies Readonly<Record<string, OpenAIModelPricing>>,
  /** Per `search` action of the web search tool; its content tokens are billed as input. */
  webSearchPerCallUsd: 0.01,
} as const;
