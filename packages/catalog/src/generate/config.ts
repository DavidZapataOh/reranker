import { AppError, cost, type ProviderCost } from "@reranker/schema";
import type { MeasurementLanguage } from "@reranker/schema/measurement";
import { jcs, promptSha256, sha256Hex } from "../hash";
import { TEMPLATE_LANGUAGES, templatesVersion } from "../templates";
import { GENERATION_LANGUAGES, type GenerationLanguage, promptsFor } from "./prompts";

export interface GeneratorConfig {
  version: 1;
  models: {
    openai: "gpt-6.1-terra";
    gemini: "gemini-3.8-flash";
    judge: "gpt-6.1-terra";
    embeddings: "text-embedding-3-small";
  };
  /** The least thinking that keeps each call's quality, so the whole set fits the deadline. */
  reasoning: { openai: "none"; gemini: "low"; judge: "low" };
  perCall: 12;
  personas: 3;
  dedupe: 0.9;
  centroid: 0.6;
  keep: 12;
  minPerFormat: 2;
  intents: 6;
  complete: 5;
  minVariants: 7;
  /** sha256 of each language's prompts, so any wording change in any language yields a new config hash. */
  prompts: Readonly<Record<GenerationLanguage, PromptHashes>>;
  /** Every language's set is pinned, so a new set in any language yields a new config hash. */
  templatesVersions: Readonly<Partial<Record<MeasurementLanguage, string>>>;
}

interface PromptHashes {
  paraphrase: string;
  persona: string;
  judge: string;
  /** The variety and address words, which reach the model in every payload. */
  profile: string;
}

function promptHashes(language: GenerationLanguage): PromptHashes {
  const { paraphrase, persona, judge, variety, address } = promptsFor(language);
  return {
    paraphrase: promptSha256(paraphrase),
    persona: promptSha256(persona),
    judge: promptSha256(judge),
    profile: sha256Hex(jcs({ variety, address: address ?? null })),
  };
}

const deepFreeze = <T extends object>(value: T): Readonly<T> => {
  for (const child of Object.values(value)) {
    if (typeof child === "object" && child !== null) deepFreeze(child);
  }
  return Object.freeze(value);
};

export const GENERATOR_CONFIG: Readonly<GeneratorConfig> = deepFreeze({
  version: 1,
  models: {
    openai: "gpt-6.1-terra",
    gemini: "gemini-3.8-flash",
    judge: "gpt-6.1-terra",
    embeddings: "text-embedding-3-small",
  },
  reasoning: { openai: "none", gemini: "low", judge: "low" },
  perCall: 12,
  personas: 3,
  dedupe: 0.9,
  centroid: 0.6,
  keep: 12,
  minPerFormat: 2,
  intents: 6,
  complete: 5,
  minVariants: 7,
  prompts: Object.fromEntries(GENERATION_LANGUAGES.map((l) => [l, promptHashes(l)])) as Record<
    GenerationLanguage,
    PromptHashes
  >,
  templatesVersions: Object.fromEntries(TEMPLATE_LANGUAGES.map((l) => [l, templatesVersion(l)])),
});

export const generatorConfigHash: string = sha256Hex(jcs(GENERATOR_CONFIG));

export type GeneratorModel = GeneratorConfig["models"][keyof GeneratorConfig["models"]];

export interface TokenUsage {
  /** Every input token; the cached and cache-write parts are billed at their own rates. */
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
}

/** Micro-USD per 1M tokens, which is also USD per 1M tokens times 10^6. */
interface Rates {
  input: number;
  cachedInput: number;
  cacheWrite: number;
  output: number;
}

// List prices read on 2026-11-20: https://developers.openai.com/api/docs/pricing (Standard) and
// https://ai.google.dev/gemini-api/docs/pricing (Paid Tier, Standard). Prompts here stay far
// below the 272K-token long-context tier. Gemini implicit caching bills no write.
const PRICES: Readonly<
  Record<GeneratorModel, ReadonlyArray<{ from: string | null; rates: Rates }>>
> = {
  "gpt-6.1-terra": [
    {
      from: null,
      rates: { input: 1_000_000, cachedInput: 50_000, cacheWrite: 1_250_000, output: 5_000_000 },
    },
  ],
  "gemini-3.8-flash": [
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
  "text-embedding-3-small": [
    { from: null, rates: { input: 20_000, cachedInput: 20_000, cacheWrite: 20_000, output: 0 } },
  ],
};

const TOKENS_PER_UNIT = 1_000_000;

function ratesFor(model: GeneratorModel, at: Date): Rates {
  const period = PRICES[model]?.findLast((p) => p.from === null || Date.parse(p.from) <= +at);
  // A model without a price would reserve nothing and spend without a cap.
  if (!period) throw new AppError("internal", { detail: `No token price for model ${model}` });
  return period.rates;
}

/** What a finished call cost, rounded up to the micro-USD. */
export function costOf(model: GeneratorModel, usage: TokenUsage, at = new Date()): ProviderCost {
  const rates = ratesFor(model, at);
  const uncached = usage.inputTokens - usage.cachedInputTokens - usage.cacheWriteTokens;
  const scaled =
    uncached * rates.input +
    usage.cachedInputTokens * rates.cachedInput +
    usage.cacheWriteTokens * rates.cacheWrite +
    usage.outputTokens * rates.output;
  return cost(Math.ceil(scaled / TOKENS_PER_UNIT), "USD");
}

/** Reservation before a call runs: every input token at its dearest rate, the full output budget. */
export function estimateOf(
  model: GeneratorModel,
  inputTokens: number,
  outputTokens: number,
  at = new Date(),
): ProviderCost {
  const rates = ratesFor(model, at);
  const scaled =
    inputTokens * Math.max(rates.input, rates.cacheWrite) + outputTokens * rates.output;
  return cost(Math.ceil(scaled / TOKENS_PER_UNIT), "USD");
}
