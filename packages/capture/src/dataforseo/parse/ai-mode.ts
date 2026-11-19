import type { EngineAnswer } from "../../answer";
import { overviewAnswer } from "./ai-overview";
import { firstResult, list } from "./wire";

/** Google's AI Mode answer from DataForSEO's SERP API, Live or task_get/advanced. */
export function parseAiMode(bytes: Uint8Array): EngineAnswer {
  const result = firstResult<{ items?: unknown }>(bytes);
  return overviewAnswer(list(result.items), "google-ai-mode", "ai-mode@1");
}
