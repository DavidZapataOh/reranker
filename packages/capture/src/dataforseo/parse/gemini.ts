import type { IAiOptimizationGeminiLlmScraperLiveAdvancedResultInfo } from "dataforseo-client";
import type { EngineAnswer } from "../../answer";
import { field, firstResult, list, queries, sources, text } from "./wire";

/** Gemini answer from DataForSEO's LLM Scraper, Live or task_get/advanced. */
export function parseGemini(bytes: Uint8Array): EngineAnswer {
  const result = firstResult<IAiOptimizationGeminiLlmScraperLiveAdvancedResultInfo>(bytes);
  const inline = list(result.items).flatMap((item) => list(field(item, "sources")));
  return {
    parserVersion: "gemini@1",
    engine: "gemini",
    channel: "ui-vendor",
    provider: "dataforseo",
    modelReported: text(result.model) ?? null,
    present: true,
    markdown: text(result.markdown) ?? "",
    // Grounding redirects stay as returned; resolveRedirects adds where they lead.
    sources: sources([...list(result.sources), ...inline]),
    // The documented result has no fan-out; only a payload that carries one reports it.
    searchQueries: Array.isArray(result.fan_out_queries)
      ? queries(result.fan_out_queries)
      : "unavailable",
  };
}
