import { InvalidInputError } from "@reranker/jobs/errors";
import type { EngineId } from "@reranker/schema";
import type { CaptureAdapter } from "../adapters";
import type { EngineAnswer } from "../answer";
import { captureLive } from "./live";
import { parseAiMode } from "./parse/ai-mode";
import { parseAiOverview } from "./parse/ai-overview";
import { parseChatGpt } from "./parse/chatgpt";
import { parseGemini } from "./parse/gemini";

const PARSERS: Partial<Record<EngineId, (bytes: Uint8Array) => EngineAnswer>> = {
  chatgpt: parseChatGpt,
  gemini: parseGemini,
  "google-ai-overview": parseAiOverview,
  "google-ai-mode": parseAiMode,
};

export const dataforseoAdapter: CaptureAdapter = {
  provider: "dataforseo",
  channel: "ui-vendor",
  async captureLive(slot) {
    const parse = PARSERS[slot.engine];
    if (!parse) throw new InvalidInputError(`${slot.engine} is not captured through DataForSEO`);
    return captureLive(slot, parse);
  },
};
