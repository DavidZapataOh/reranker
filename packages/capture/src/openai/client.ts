import { defineEnv } from "@reranker/env";
import OpenAI from "openai";
import type { ResponseCreateParamsNonStreaming } from "openai/resources/responses/responses";
import type { RawSink } from "../raw/raw-sink";
import { recordingFetch } from "../raw/tee-fetch";
import { openaiControlEnv } from "./env";

// The spec's p95 is under 30 s; a call still open at 90 s is stuck, not slow.
const CONTROL_TIMEOUT_MS = 90_000;

/**
 * The official client over a fetch that keeps each call's exact request and response bytes in
 * `sink`. Retries belong to the capture step, which holds the provider slot and the reservation.
 */
export function createOpenAIControl(sink: RawSink, opts: { apiKey?: string } = {}): OpenAI {
  const apiKey = opts.apiKey ?? defineEnv([openaiControlEnv]).OPENAI_CONTROL_API_KEY;
  if (!apiKey) throw new Error("OpenAI control API key missing: set OPENAI_CONTROL_API_KEY");
  return new OpenAI({
    apiKey,
    maxRetries: 0,
    timeout: CONTROL_TIMEOUT_MS,
    fetch: recordingFetch(sink, { timeoutMs: CONTROL_TIMEOUT_MS }),
  });
}

/** One Responses API call, returning the untouched HTTP response and the body bytes it carried. */
export async function callControl(
  client: OpenAI,
  params: ResponseCreateParamsNonStreaming,
): Promise<{ response: Response; bytes: Uint8Array }> {
  const response = await client.responses.create(params).asResponse();
  return { response, bytes: new Uint8Array(await response.arrayBuffer()) };
}
