import { breakerRecord } from "@reranker/jobs";
import { ProviderUnavailableError } from "@reranker/jobs/errors";
import { cost, type ProviderCost } from "@reranker/schema";
import { APIConnectionTimeoutError } from "openai";
import type { ResponseUsage } from "openai/resources/responses/responses";
import type { CaptureAdapter, CaptureRecord } from "../adapters";
import { safeParseAnswer } from "../answer";
import { RawSink } from "../raw/raw-sink";
import { type FrozenSlot, newCaptureId } from "../slot";
import { callControl, createOpenAIControl } from "./client";
import { CONTROL_RESERVE, costFromUsage } from "./cost";
import { mapOpenAIError } from "./errors";
import { parseOpenAIResponse } from "./parse";
import { CONTROL_PROFILE } from "./profile";
import { buildControlRequest } from "./request";

// Nothing came back, so there is no advertised delay; a few seconds spreads a burst's retries.
const NO_RESPONSE_RETRY_MS = 5000;

type Body = { id?: unknown; model?: unknown; usage?: ResponseUsage; output?: unknown };

function json(bytes: Uint8Array): Body | null {
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return value !== null && typeof value === "object" ? (value as Body) : null;
  } catch {
    return null;
  }
}

const text = (value: unknown) => (typeof value === "string" && value !== "" ? value : null);

// Billed per `search` action, as costFromUsage prices them.
function searchesIn(body: Body): number {
  if (!Array.isArray(body.output)) return 0;
  return body.output.filter(
    (item) => item?.type === "web_search_call" && item.action?.type === "search",
  ).length;
}

function billed(body: Body | null): ProviderCost | null {
  const model = text(body?.model);
  if (!body?.usage || !model) return null;
  try {
    return costFromUsage(body.usage, searchesIn(body), model);
  } catch {
    // An unpriced snapshot was still paid for: the full reservation settles it, never zero.
    return null;
  }
}

const isTimeout = (error: unknown) =>
  error instanceof APIConnectionTimeoutError ||
  (error instanceof DOMException && error.name === "TimeoutError");

/**
 * One Responses API call for a control slot. Whatever came back is returned to be sealed, error
 * responses included; it throws only when nothing arrived. Every outcome counts on the breaker.
 */
async function captureLive(slot: FrozenSlot): Promise<CaptureRecord> {
  const params = buildControlRequest(slot);
  const sink = new RawSink();
  const client = createOpenAIControl(sink);
  const started = performance.now();
  let thrown: unknown = null;
  try {
    await callControl(client, params);
  } catch (error) {
    // Nothing went out, so this is no provider outcome.
    if (sink.calls === 0) throw error;
    thrown = error;
  }
  const latencyMs = Math.round(performance.now() - started);
  const failure = thrown === null ? null : mapOpenAIError(thrown);
  await breakerRecord("openai", failure?.breakerFailure ? "failure" : "success");
  if (sink.status === null || sink.request === null || sink.url === null) {
    throw failure?.error ?? new ProviderUnavailableError("openai", NO_RESPONSE_RETRY_MS);
  }

  const response = sink.response ?? new Uint8Array();
  const headers = sink.headers ?? new Headers();
  const body = json(response);
  const timedOut = isTimeout(thrown);
  const parsed = failure
    ? { answer: null, error: null }
    : safeParseAnswer(
        (bytes) => parseOpenAIResponse(bytes, headers, CONTROL_PROFILE.model),
        response,
      );
  return {
    slot,
    captureId: newCaptureId(),
    status: failure ? (timedOut ? "timeout" : "provider_error") : "succeeded",
    providerStatusCode: null,
    httpStatus: sink.status,
    request: sink.request,
    response,
    responseContentType: sink.contentType ?? "application/octet-stream",
    endpoint: sink.url,
    providerTaskId: text(body?.id),
    answer: parsed.answer,
    parseError: parsed.error,
    modelReported: text(body?.model),
    // OpenAI bills no error response; a cut-off call may still have run, so it keeps its hold.
    cost: timedOut ? null : failure ? cost(0, "USD") : billed(body),
    latencyMs,
    mode: "live",
    ...(failure ? { failure: { error: failure.error, retryable: failure.retryable } } : {}),
  };
}

export const openaiAdapter: CaptureAdapter = {
  provider: "openai",
  channel: "api",
  estimate: () => CONTROL_RESERVE,
  captureLive,
};
