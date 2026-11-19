import { InvalidInputError } from "@reranker/jobs";
import { cost, type ProviderCost } from "@reranker/schema";
import type { ResponseUsage } from "openai/resources/responses/responses";
import { OPENAI_PRICING, type OpenAIModelPricing, type OpenAITokenRates } from "../pricing/openai";

const MODELS: Readonly<Record<string, OpenAIModelPricing>> = OPENAI_PRICING.models;
const SNAPSHOT_SUFFIX = /-\d{4}-\d{2}-\d{2}$/;
const MICROS_PER_USD = 1_000_000;

/** Spend held for one control call before it runs. */
export const CONTROL_RESERVE: ProviderCost = cost(50_000, "USD");

function pricingOf(model: string): OpenAIModelPricing {
  const base = model.replace(SNAPSHOT_SUFFIX, "");
  const name = Object.hasOwn(MODELS, model) ? model : base;
  const pricing = Object.hasOwn(MODELS, name) ? MODELS[name] : undefined;
  // A guessed price would settle the ledger with a number OpenAI never billed.
  if (!pricing) throw new InvalidInputError(`No OpenAI price for model ${model}`);
  return pricing;
}

function isCount(n: number): boolean {
  return Number.isSafeInteger(n) && n >= 0;
}

/**
 * What a finished Responses API call cost, from the usage OpenAI returned. `searches` counts the
 * `web_search_call` items whose action is `search`, the only web search action billed per call.
 */
export function costFromUsage(usage: ResponseUsage, searches: number, model: string): ProviderCost {
  const pricing = pricingOf(model);
  const input = usage.input_tokens;
  const { cached_tokens: cached, cache_write_tokens: written } = usage.input_tokens_details;
  const written12h = usage.input_tokens_details.cache_write_tokens_details?.ttl_12h_tokens ?? 0;
  const uncached = input - cached - written;
  if (
    ![input, cached, written, written12h, usage.output_tokens, searches].every(isCount) ||
    uncached < 0 ||
    written12h > written
  ) {
    throw new InvalidInputError(`Unbillable OpenAI usage for model ${model}`);
  }

  const rates: OpenAITokenRates =
    input > pricing.longContext.aboveInputTokens ? pricing.longContext : pricing;
  // Reasoning tokens are already inside output_tokens.
  const micros =
    uncached * rates.inPerM +
    cached * rates.cachedInPerM +
    (written - written12h) * rates.cacheWrite30mPerM +
    written12h * rates.cacheWrite12hPerM +
    usage.output_tokens * rates.outPerM +
    searches * OPENAI_PRICING.webSearchPerCallUsd * MICROS_PER_USD;
  return cost(Math.round(micros), "USD");
}
