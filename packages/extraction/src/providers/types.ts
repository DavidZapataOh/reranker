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
  usage: { inputTokens: number; cachedInputTokens: number; outputTokens: number };
  raw: unknown;
}

export type StructuredCaller = <T>(call: StructuredCall<T>) => Promise<StructuredResult<T>>;

/** The model declined to answer; the call was billed but there is no output to parse. */
export class ProviderRefusalError extends Error {
  readonly provider: LlmProvider;

  constructor(provider: LlmProvider, message: string) {
    super(message);
    this.name = "ProviderRefusal";
    this.provider = provider;
  }
}

/** The answer stopped before the structured output was complete (token limit, safety stop). */
export class ProviderIncompleteError extends Error {
  readonly provider: LlmProvider;
  readonly reason: string;

  constructor(provider: LlmProvider, reason: string) {
    super(`${provider} returned an incomplete answer: ${reason}`);
    this.name = "ProviderIncomplete";
    this.provider = provider;
    this.reason = reason;
  }
}
