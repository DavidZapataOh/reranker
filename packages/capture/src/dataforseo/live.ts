import { breakerRecord, InvalidInputError, ProviderUnavailableError } from "@reranker/jobs";
import { costFromMajor, type EngineId, type ProviderCost } from "@reranker/schema";
import type {
  AiOptimizationChatGptLlmScraperLiveAdvancedRequestInfo,
  AiOptimizationGeminiLlmScraperLiveAdvancedRequestInfo,
  SerpGoogleAiModeLiveAdvancedRequestInfo,
  SerpGoogleOrganicLiveAdvancedRequestInfo,
} from "dataforseo-client";
import type { CaptureRecord } from "../adapters";
import { type EngineAnswer, safeParseAnswer } from "../answer";
import { RawSink } from "../raw/raw-sink";
import { type FrozenSlot, newCaptureId } from "../slot";
import { createDataForSeo } from "./client";
import { buildRequest, type DataForSeoRequest } from "./request";
import { type DataForSeoOutcome, mapDataForSeoStatus, providerStatusCode } from "./status";

type Clients = ReturnType<typeof createDataForSeo>;
type LiveCall = (clients: Clients, request: DataForSeoRequest) => Promise<unknown>;

// buildRequest returns the request class of the engine's endpoint, so each cast only names it.
export const LIVE: Partial<Record<EngineId, LiveCall>> = {
  gemini: (c, r) =>
    c.ai.geminiLlmScraperLiveAdvanced([r as AiOptimizationGeminiLlmScraperLiveAdvancedRequestInfo]),
  chatgpt: (c, r) =>
    c.ai.chatGptLlmScraperLiveAdvanced([
      r as AiOptimizationChatGptLlmScraperLiveAdvancedRequestInfo,
    ]),
  "google-ai-overview": (c, r) =>
    c.serp.googleOrganicLiveAdvanced([r as SerpGoogleOrganicLiveAdvancedRequestInfo]),
  "google-ai-mode": (c, r) =>
    c.serp.googleAiModeLiveAdvanced([r as SerpGoogleAiModeLiveAdvancedRequestInfo]),
};

// Nothing came back, so there is no advertised delay; a few seconds spreads a burst's retries.
const RETRY_AFTER_MS = 5000;

// A fixed text: the parser's own message would quote the body.
const NOT_JSON = "SyntaxError: the response body is not JSON";

function json(bytes: Uint8Array): unknown | null {
  if (bytes.length === 0) return null;
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

const field = (value: unknown, key: string): unknown =>
  value !== null && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;

const first = (value: unknown): unknown => (Array.isArray(value) ? value[0] : undefined);

/** The task's billed cost, or the envelope's when the call failed before any task ran. */
export function reportedCost(body: unknown): ProviderCost | null {
  const task = first(field(body, "tasks"));
  const usd = field(task, "cost") ?? field(body, "cost");
  // DataForSEO bills in fractions of a cent, never below a micro-dollar.
  return typeof usd === "number" && Number.isFinite(usd) && usd >= 0
    ? costFromMajor(usd.toFixed(6), "USD")
    : null;
}

export function reportedTaskId(body: unknown): string | null {
  const id = field(first(field(body, "tasks")), "id");
  return typeof id === "string" && id !== "" ? id : null;
}

function reportedModel(body: unknown): string | null {
  const model = field(first(field(first(field(body, "tasks")), "result")), "model");
  return typeof model === "string" && model !== "" ? model : null;
}

const isTimeout = (error: unknown) => error instanceof Error && error.name === "TimeoutError";

/** What one call left on the wire, with the outcome its status decides. */
export interface Exchange {
  url: string;
  httpStatus: number;
  request: Uint8Array | null;
  response: Uint8Array;
  responseContentType: string;
  body: unknown | null;
  outcome: DataForSeoOutcome;
  timedOut: boolean;
  latencyMs: number;
}

/**
 * Runs one call of the official client over `sink` and reads back what crossed the wire. It
 * throws only when nothing arrived, and counts every outcome on the breaker.
 */
export async function exchange(sink: RawSink, call: () => Promise<unknown>): Promise<Exchange> {
  const started = performance.now();
  let timedOut = false;
  try {
    await call();
  } catch (error) {
    // Nothing went out, so this is no provider outcome.
    if (sink.calls === 0) throw error;
    // The official client throws on any non-200 status and on a body that is not JSON; the sink
    // still holds the bytes, which decide the outcome below.
    timedOut = isTimeout(error);
  }
  const latencyMs = Math.round(performance.now() - started);

  if (sink.status === null || sink.url === null) {
    await breakerRecord("dataforseo", "failure");
    throw new ProviderUnavailableError("dataforseo", RETRY_AFTER_MS);
  }

  const response = sink.response ?? new Uint8Array();
  const body = json(response);
  const outcome = mapDataForSeoStatus({ httpStatus: sink.status, body, timedOut });
  await breakerRecord("dataforseo", !outcome.ok && outcome.breakerFailure ? "failure" : "success");
  return {
    url: sink.url,
    httpStatus: sink.status,
    request: sink.request,
    response,
    responseContentType: sink.contentType ?? "application/octet-stream",
    body,
    outcome,
    timedOut,
    latencyMs,
  };
}

/** The capture of `slot` from what came back, provider errors and unreadable bodies included. */
export function recordOf(
  slot: FrozenSlot,
  sent: Exchange & { request: Uint8Array },
  parse: (bytes: Uint8Array) => EngineAnswer,
  mode: CaptureRecord["mode"],
): CaptureRecord {
  const { outcome, response, body, timedOut } = sent;
  const parsed = outcome.ok
    ? safeParseAnswer(parse, response)
    : { answer: null, error: response.length > 0 && body === null ? NOT_JSON : null };
  return {
    slot,
    captureId: newCaptureId(),
    status: outcome.ok ? "succeeded" : timedOut ? "timeout" : "provider_error",
    providerStatusCode: providerStatusCode(body),
    httpStatus: sent.httpStatus,
    request: sent.request,
    response,
    responseContentType: sent.responseContentType,
    endpoint: sent.url,
    providerTaskId: reportedTaskId(body),
    answer: parsed.answer,
    parseError: parsed.error,
    modelReported: reportedModel(body),
    // Fetching a queued task's result is free: the task was billed when it was posted.
    cost: timedOut || mode === "task" ? null : reportedCost(body),
    latencyMs: sent.latencyMs,
    mode,
  };
}

/**
 * One Live call for a slot. Whatever came back is returned to be sealed, provider errors
 * included; it throws only when nothing arrived. Every outcome is counted on the breaker.
 */
export async function captureLive(
  slot: FrozenSlot,
  parse: (bytes: Uint8Array) => EngineAnswer,
  opts: { timeoutMs?: number } = {},
): Promise<CaptureRecord> {
  const call = LIVE[slot.engine];
  if (!call) throw new InvalidInputError(`${slot.engine} has no DataForSEO Live endpoint`);
  const request = buildRequest(slot, "live");
  const sink = new RawSink();
  const clients = createDataForSeo(sink, opts);
  const sent = await exchange(sink, () => call(clients, request));
  if (sent.request === null) {
    await breakerRecord("dataforseo", "failure");
    throw new ProviderUnavailableError("dataforseo", RETRY_AFTER_MS);
  }
  return recordOf(slot, { ...sent, request: sent.request }, parse, "live");
}
