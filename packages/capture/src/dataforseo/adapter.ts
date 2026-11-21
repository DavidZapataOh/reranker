import { InvalidInputError } from "@reranker/jobs/errors";
import type { EngineId } from "@reranker/schema";
import type { CaptureAdapter } from "../adapters";
import type { EngineAnswer } from "../answer";
import { captureLive } from "./live";
import { parseAiMode } from "./parse/ai-mode";
import { parseAiOverview } from "./parse/ai-overview";
import { parseChatGpt } from "./parse/chatgpt";
import { parseGemini } from "./parse/gemini";
import { collectReady, collectTask, findTasks, postTask } from "./tasks";

const PARSERS: Partial<Record<EngineId, (bytes: Uint8Array) => EngineAnswer>> = {
  chatgpt: parseChatGpt,
  gemini: parseGemini,
  "google-ai-overview": parseAiOverview,
  "google-ai-mode": parseAiMode,
};

function parserOf(engine: EngineId): (bytes: Uint8Array) => EngineAnswer {
  const parse = PARSERS[engine];
  if (!parse) throw new InvalidInputError(`${engine} is not captured through DataForSEO`);
  return parse;
}

export const dataforseoAdapter: CaptureAdapter = {
  provider: "dataforseo",
  channel: "ui-vendor",
  async captureLive(slot) {
    return captureLive(slot, parserOf(slot.engine));
  },
  parse: (engine, bytes) => parserOf(engine)(bytes),
  postTask,
  collectReady: (slots) => collectReady(slots, parserOf),
  collectTask: (slot, id) => collectTask(slot, id, parserOf(slot.engine)),
  findTasks,
};
