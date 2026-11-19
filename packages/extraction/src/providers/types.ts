import type { z } from "@reranker/schema";

export type LlmProvider = "openai" | "gemini" | "anthropic";

export interface ModelRef {
  provider: LlmProvider;
  model: string;
  reasoning: "none" | "minimal" | "low";
}

export interface StructuredCall<T> {
  model: ModelRef;
  system: string;
  user: string;
  schema: z.ZodType<T>;
  schemaName: string;
  signal: AbortSignal;
  maxOutputTokens: number;
}

export interface StructuredResult<T> {
  output: T;
  modelReported: string;
  /**
   * `inputTokens` counts every input token; `cachedInputTokens` (cache reads) and
   * `cacheWriteTokens` are the parts of it billed at their own rates.
   */
  usage: {
    inputTokens: number;
    cachedInputTokens: number;
    cacheWriteTokens: number;
    outputTokens: number;
  };
  raw: unknown;
}

export type StructuredCaller = <T>(call: StructuredCall<T>) => Promise<StructuredResult<T>>;

export type StructuredUsage = StructuredResult<unknown>["usage"];

// Billing contract for the errors below: an answer that came back was billed. `usage` is what the
// provider reported for it, and the caller settles the spend from it. `usage` is absent only when
// no answer came back with usage, and then the caller settles the reserved amount, since the
// provider may still have billed the call.

/** The model declined to answer; the call was billed but there is no output to parse. */
export class ProviderRefusalError extends Error {
  readonly provider: LlmProvider;
  readonly usage: StructuredUsage | undefined;

  constructor(provider: LlmProvider, message: string, usage?: StructuredUsage) {
    super(message);
    this.name = "ProviderRefusal";
    this.provider = provider;
    this.usage = usage;
  }
}

/**
 * The answer stopped before the structured output was complete (token limit, safety stop) or
 * its output did not match the schema (`invalid_output`); either way it was billed.
 */
export class ProviderIncompleteError extends Error {
  readonly provider: LlmProvider;
  readonly reason: string;
  readonly usage: StructuredUsage | undefined;

  constructor(provider: LlmProvider, reason: string, usage?: StructuredUsage) {
    super(`${provider} returned an incomplete answer: ${reason}`);
    this.name = "ProviderIncomplete";
    this.provider = provider;
    this.reason = reason;
    this.usage = usage;
  }
}
