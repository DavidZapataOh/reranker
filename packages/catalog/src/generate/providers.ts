import { GoogleGenAI, type GoogleGenAIInteraction } from "@google/genai";
import { defineEnv } from "@reranker/env";
import {
  breakerRecord,
  ProviderRejectedError,
  ProviderUnavailableError,
  RateLimitedError,
} from "@reranker/jobs";
import { z } from "@reranker/schema";
import {
  type BusinessCategory,
  type IntentKind,
  ParaphraseFormat,
  type QuestionScope,
  type RegisterProfile,
} from "@reranker/schema/measurement";
import OpenAI, { APIError } from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import type { Response } from "openai/resources/responses/responses";
import { GENERATOR_CONFIG, type TokenUsage } from "./config";
import { catalogEnv } from "./env";
import type { Candidate } from "./guards";
import { type GenerationLanguage, promptsFor } from "./prompts";
import { BilledFailure, type CallContext, paidCall } from "./spend";

export type { GenerationLanguage } from "./prompts";

export interface DraftIntent {
  category: BusinessCategory;
  scope: QuestionScope;
  kind: IntentKind;
  slug: string;
  canonicalText: string;
  language: GenerationLanguage;
  registerProfile: RegisterProfile;
}

const MAX_OUTPUT_TOKENS = { openai: 2048, gemini: 4096, judge: 4096 } as const;
// Spanish averages over three characters per token and English about four; three keeps the
// reservation above real use.
const CHARS_PER_TOKEN = 3;
const DEFAULT_RETRY_AFTER_MS = 1000;

// 429s and 402s that only a billing change fixes
// (https://developers.openai.com/api/docs/guides/error-codes, https://ai.google.dev/gemini-api/docs/api-errors).
const BILLING_CODES = new Set([
  "insufficient_quota",
  "credit_balance_exhausted",
  "organization_spend_limit_exceeded",
  "project_spend_limit_exceeded",
  "organization_usage_limit_exceeded",
  "payment_required",
  "quota_exceeded",
]);

let openaiClient: OpenAI | undefined;
let geminiClient: GoogleGenAI | undefined;
// Retries belong to the caller, which holds the provider slot and the spend reservation.
const openai = () =>
  (openaiClient ??= new OpenAI({
    apiKey: defineEnv([catalogEnv.pick({ OPENAI_API_KEY: true })]).OPENAI_API_KEY,
    maxRetries: 0,
  }));
const gemini = () =>
  (geminiClient ??= new GoogleGenAI({
    apiKey: defineEnv([catalogEnv.pick({ GEMINI_API_KEY: true })]).GEMINI_API_KEY,
  }));

function retryAfterMs(headers: Headers | undefined): number {
  const ms = Number.parseFloat(headers?.get("retry-after-ms") ?? "");
  if (ms > 0) return ms;
  const seconds = Number.parseFloat(headers?.get("retry-after") ?? "");
  return seconds > 0 ? seconds * 1000 : DEFAULT_RETRY_AFTER_MS;
}

interface HttpFailure {
  status: number | undefined;
  headers: Headers | undefined;
  code: string | undefined;
}

// Only the provider's code leaves the error: its message can echo the prompt.
async function failure(provider: "openai" | "gemini", error: HttpFailure): Promise<never> {
  const outage = error.status === undefined || error.status >= 500;
  await breakerRecord(provider, outage ? "failure" : "success");
  if (outage) throw new ProviderUnavailableError(provider, retryAfterMs(error.headers));
  if (error.status === 429 && !BILLING_CODES.has(error.code ?? "")) {
    throw new RateLimitedError(retryAfterMs(error.headers), provider);
  }
  throw new ProviderRejectedError(provider, error.code ?? `http_${error.status}`);
}

const stringOr = (value: unknown) => (typeof value === "string" ? value : undefined);

function openaiFailure(error: unknown): Promise<never> {
  if (!(error instanceof APIError)) throw error;
  const code = stringOr(error.code) ?? stringOr(error.type);
  return failure("openai", { status: error.status, headers: error.headers, code });
}

// The Interactions client does not export its error classes, so they are read by shape.
function geminiFailure(error: unknown): Promise<never> {
  if (!(error instanceof Error && "status" in error && "headers" in error && "error" in error)) {
    throw error;
  }
  const body = error.error as { error?: { code?: unknown }; code?: unknown } | undefined;
  return failure("gemini", {
    status: error.status as number | undefined,
    headers: error.headers as Headers | undefined,
    code: stringOr(body?.error?.code) ?? stringOr(body?.code),
  });
}

function parsed<T>(schema: z.ZodType<T>, text: string | undefined): T | undefined {
  if (text === undefined) return undefined;
  try {
    const result = schema.safeParse(JSON.parse(text));
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}

interface StructuredCall<T> {
  schema: z.ZodType<T>;
  name: string;
  system: string;
  user: string;
}

const inputTokens = (call: { system: string; user: string }) =>
  Math.ceil((call.system.length + call.user.length) / CHARS_PER_TOKEN);

function openaiUsage(response: Response): TokenUsage | undefined {
  const usage = response.usage;
  if (!usage) return undefined;
  return {
    inputTokens: usage.input_tokens,
    cachedInputTokens: usage.input_tokens_details.cached_tokens,
    cacheWriteTokens: usage.input_tokens_details.cache_write_tokens ?? 0,
    outputTokens: usage.output_tokens,
  };
}

/** Structured output through the Responses API. Every answer that comes back was billed. */
function callOpenAI<T>(call: StructuredCall<T>, role: "openai" | "judge", ctx: CallContext) {
  const model = GENERATOR_CONFIG.models[role];
  const tokens = { input: inputTokens(call), output: MAX_OUTPUT_TOKENS[role] };
  return paidCall("openai", model, tokens, ctx, async () => {
    const response = await openai()
      .responses.create(
        {
          model,
          instructions: call.system,
          input: call.user,
          text: { format: zodTextFormat(call.schema, call.name) },
          reasoning: { effort: GENERATOR_CONFIG.reasoning[role] },
          max_output_tokens: tokens.output,
          store: false,
        },
        { signal: ctx.signal },
      )
      .catch(openaiFailure);
    await breakerRecord("openai", "success");
    const usage = openaiUsage(response);
    if (response.status === "incomplete") {
      throw new BilledFailure(response.incomplete_details?.reason ?? "incomplete", usage);
    }
    const content = response.output.flatMap((item) =>
      item.type === "message" ? item.content : [],
    );
    if (content.some((part) => part.type === "refusal")) throw new BilledFailure("refusal", usage);
    const text = content.find((part) => part.type === "output_text")?.text;
    const value = parsed(call.schema, text);
    if (value === undefined || !usage) throw new BilledFailure("invalid_output", usage);
    return { value, usage };
  });
}

// Thinking is billed as output (https://ai.google.dev/gemini-api/docs/thinking#pricing).
function geminiUsage(interaction: GoogleGenAIInteraction): TokenUsage | undefined {
  const usage = interaction.usage;
  if (usage?.total_input_tokens === undefined || usage.total_output_tokens === undefined) {
    return undefined;
  }
  return {
    inputTokens: usage.total_input_tokens,
    cachedInputTokens: usage.total_cached_tokens ?? 0,
    cacheWriteTokens: 0,
    outputTokens: usage.total_output_tokens + (usage.total_thought_tokens ?? 0),
  };
}

/** Structured output through the Interactions API, stateless. Every answer that comes back was billed. */
function callGemini<T>(call: StructuredCall<T>, ctx: CallContext) {
  const model = GENERATOR_CONFIG.models.gemini;
  const tokens = { input: inputTokens(call), output: MAX_OUTPUT_TOKENS.gemini };
  return paidCall("gemini", model, tokens, ctx, async () => {
    const interaction = await gemini()
      .interactions.create(
        {
          model,
          system_instruction: call.system,
          input: call.user,
          response_format: {
            type: "text",
            mime_type: "application/json",
            schema: z.toJSONSchema(call.schema),
          },
          generation_config: {
            thinking_level: GENERATOR_CONFIG.reasoning.gemini,
            max_output_tokens: tokens.output,
          },
          store: false,
          // One request per call: the reservation covers a single decode.
          automatic_continuation: false,
        },
        { signal: ctx.signal, maxRetries: 0 },
      )
      .catch(geminiFailure);
    await breakerRecord("gemini", "success");
    const usage = geminiUsage(interaction);
    if (interaction.status !== "completed") {
      throw new BilledFailure(interaction.errors?.[0]?.code ?? interaction.status, usage);
    }
    const value = parsed(call.schema, interaction.output_text);
    if (value === undefined || !usage) throw new BilledFailure("invalid_output", usage);
    return { value, usage };
  });
}

const ParaphraseList = z.object({
  paraphrases: z.array(z.object({ text: z.string(), format: ParaphraseFormat })),
});
const ParaphrasesWithPersonas = ParaphraseList.extend({ personas: z.array(z.string()) });
const Verdicts = z.object({
  verdicts: z.array(z.object({ id: z.number().int(), keep: z.boolean() })),
});

// The category's label and noun come in the intent's language: the caller names them as people
// asking in it do, never translated.
function intentPayload(intent: DraftIntent) {
  const { variety, address } = promptsFor(intent.language);
  return {
    category: intent.category.label,
    noun: intent.category.noun,
    kind: intent.kind,
    canonical: intent.canonicalText,
    scope: intent.scope,
    variety: variety[intent.registerProfile],
    ...(address && { address: address[intent.category.register] }),
  };
}

/**
 * Paraphrases of one intent from one provider, plus personas when asked. An answer that came back
 * unusable (refusal, truncation, invalid JSON) yields nothing; transport failures throw.
 */
export async function generateParaphrases(
  provider: "openai" | "gemini",
  req: { intent: DraftIntent; register: RegisterProfile; withPersonas: boolean },
  ctx: CallContext,
): Promise<{ paraphrases: Candidate[]; personas: string[] }> {
  const prompts = promptsFor(req.intent.language);
  const payload = {
    ...intentPayload({ ...req.intent, registerProfile: req.register }),
    count: GENERATOR_CONFIG.perCall,
    ...(req.withPersonas && { personas: GENERATOR_CONFIG.personas }),
  };
  const call = {
    schema: req.withPersonas ? ParaphrasesWithPersonas : ParaphraseList,
    name: "paraphrases",
    system: req.withPersonas ? `${prompts.paraphrase}\n\n${prompts.persona}` : prompts.paraphrase,
    user: JSON.stringify(payload),
  };
  let output: {
    paraphrases: Array<{ text: string; format: ParaphraseFormat }>;
    personas?: string[];
  };
  try {
    output =
      provider === "openai" ? await callOpenAI(call, "openai", ctx) : await callGemini(call, ctx);
  } catch (error) {
    if (error instanceof BilledFailure) return { paraphrases: [], personas: [] };
    throw error;
  }
  const seen = new Set<string>();
  const paraphrases: Candidate[] = [];
  for (const { text, format } of output.paraphrases) {
    const clean = text.trim();
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    paraphrases.push({ text: clean, format, generator: provider });
  }
  const personas = [...new Set((output.personas ?? []).map((p) => p.trim()).filter(Boolean))];
  return {
    paraphrases: paraphrases.slice(0, GENERATOR_CONFIG.perCall),
    personas: personas.slice(0, GENERATOR_CONFIG.personas),
  };
}

/** One embedding per text, in input order. */
export function embed(texts: string[], ctx: CallContext): Promise<Float32Array[]> {
  if (texts.length === 0) return Promise.resolve([]);
  const model = GENERATOR_CONFIG.models.embeddings;
  const chars = texts.reduce((sum, text) => sum + text.length, 0);
  const tokens = { input: Math.ceil(chars / CHARS_PER_TOKEN) + texts.length, output: 0 };
  return paidCall("openai", model, tokens, ctx, async () => {
    const response = await openai()
      .embeddings.create({ model, input: texts, encoding_format: "float" }, { signal: ctx.signal })
      .catch(openaiFailure);
    await breakerRecord("openai", "success");
    const usage = {
      inputTokens: response.usage.prompt_tokens,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 0,
    };
    const vectors: Array<Float32Array | undefined> = new Array(texts.length).fill(undefined);
    for (const item of response.data) vectors[item.index] = Float32Array.from(item.embedding);
    if (response.data.length !== texts.length || vectors.some((v) => v === undefined)) {
      throw new BilledFailure("invalid_output", usage);
    }
    return { value: vectors as Float32Array[], usage };
  });
}

/**
 * Whether each candidate asks what the intent asks and reads like a real person in the set's
 * variety. A candidate the judge did not rule on, or an unusable answer, counts as rejected.
 */
export async function judge(
  intent: DraftIntent,
  candidates: Candidate[],
  ctx: CallContext,
): Promise<boolean[]> {
  const prompts = promptsFor(intent.language);
  if (candidates.length === 0) return [];
  const call = {
    schema: Verdicts,
    name: "verdicts",
    system: prompts.judge,
    user: JSON.stringify({
      ...intentPayload(intent),
      candidates: candidates.map((c, id) => ({ id, text: c.text })),
    }),
  };
  let verdicts: z.infer<typeof Verdicts>["verdicts"];
  try {
    verdicts = (await callOpenAI(call, "judge", ctx)).verdicts;
  } catch (error) {
    if (error instanceof BilledFailure) return candidates.map(() => false);
    throw error;
  }
  const kept = new Map(verdicts.map((v) => [v.id, v.keep]));
  return candidates.map((_, id) => kept.get(id) === true);
}
