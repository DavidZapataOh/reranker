import { getGeo } from "@reranker/catalog";
import { mainLanguage } from "@reranker/i18n/countries";
import { InvalidInputError } from "@reranker/jobs/errors";
import {
  AiOptimizationChatGptLlmScraperLiveAdvancedRequestInfo,
  AiOptimizationChatGptLlmScraperTaskPostRequestInfo,
  AiOptimizationGeminiLlmScraperLiveAdvancedRequestInfo,
  AiOptimizationGeminiLlmScraperTaskPostRequestInfo,
  SerpGoogleAiModeLiveAdvancedRequestInfo,
  SerpGoogleAiModeTaskPostRequestInfo,
  SerpGoogleOrganicLiveAdvancedRequestInfo,
  SerpGoogleOrganicTaskPostRequestInfo,
} from "dataforseo-client";
import type { FrozenSlot } from "../slot";
import { geoFields } from "./geo";

export type DataForSeoMode = "live" | "task";

export type DataForSeoRequest =
  | SerpGoogleOrganicLiveAdvancedRequestInfo
  | SerpGoogleOrganicTaskPostRequestInfo
  | SerpGoogleAiModeLiveAdvancedRequestInfo
  | SerpGoogleAiModeTaskPostRequestInfo
  | AiOptimizationGeminiLlmScraperLiveAdvancedRequestInfo
  | AiOptimizationGeminiLlmScraperTaskPostRequestInfo
  | AiOptimizationChatGptLlmScraperLiveAdvancedRequestInfo
  | AiOptimizationChatGptLlmScraperTaskPostRequestInfo;

// DataForSEO URL-decodes keywords ("+" becomes a space), so a literal % or + has to arrive
// percent-encoded for the engine to read the prompt as written.
const keyword = (text: string) => text.replaceAll("%", "%25").replaceAll("+", "%2B");

/** The single task DataForSEO runs for a slot; `tag` carries the slot id back in the response. */
export function buildRequest(slot: FrozenSlot, mode: DataForSeoMode): DataForSeoRequest {
  if (slot.provider !== "dataforseo") {
    throw new InvalidInputError(`Slot ${slot.slotId} is routed to ${slot.provider}`);
  }
  const target = getGeo(slot.geoKey);
  // The frozen slot keeps the location it declares rather than the scope: an engine is declared
  // by country exactly when it is asked nationwide (or has nothing more precise).
  const scope = slot.geoDeclared.level === "country" ? "national" : "local";
  const task = {
    keyword: keyword(slot.promptText),
    ...geoFields(slot.engine, target, scope),
    // The language the prompt is written in; slots frozen before it was recorded were asked in
    // the country's main language.
    language_code: slot.language ?? mainLanguage(target.country),
    tag: slot.slotId,
  };
  const live = mode === "live";
  switch (slot.engine) {
    case "google-ai-overview": {
      // AI Overviews often load after the SERP; without this only cached ones come back.
      const organic = { ...task, load_async_ai_overview: true };
      return live
        ? new SerpGoogleOrganicLiveAdvancedRequestInfo(organic)
        : new SerpGoogleOrganicTaskPostRequestInfo(organic);
    }
    case "google-ai-mode":
      return live
        ? new SerpGoogleAiModeLiveAdvancedRequestInfo(task)
        : new SerpGoogleAiModeTaskPostRequestInfo(task);
    case "gemini":
      return live
        ? new AiOptimizationGeminiLlmScraperLiveAdvancedRequestInfo(task)
        : new AiOptimizationGeminiLlmScraperTaskPostRequestInfo(task);
    case "chatgpt": {
      // Without it ChatGPT may answer from memory and cite nothing.
      const chatgpt = { ...task, force_web_search: true };
      return live
        ? new AiOptimizationChatGptLlmScraperLiveAdvancedRequestInfo(chatgpt)
        : new AiOptimizationChatGptLlmScraperTaskPostRequestInfo(chatgpt);
    }
    case "perplexity":
      throw new InvalidInputError("Perplexity is not captured through DataForSEO");
  }
}

/** The body the official client posts for a slot: it serializes `[request]` with JSON.stringify. */
export function requestBytes(slot: FrozenSlot, mode: DataForSeoMode): Uint8Array {
  return new TextEncoder().encode(JSON.stringify([buildRequest(slot, mode)]));
}
