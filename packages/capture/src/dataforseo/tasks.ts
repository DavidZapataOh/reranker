import { InvalidInputError } from "@reranker/jobs/errors";
import { type EngineId, z } from "@reranker/schema";
import type {
  AiOptimizationChatGptLlmScraperTaskPostRequestInfo,
  AiOptimizationGeminiLlmScraperTaskPostRequestInfo,
  SerpGoogleAiModeTaskPostRequestInfo,
  SerpGoogleOrganicTaskPostRequestInfo,
} from "dataforseo-client";
import type { CaptureRecord, PostedTask, ReadyTask } from "../adapters";
import type { EngineAnswer } from "../answer";
import { RawSink } from "../raw/raw-sink";
import type { FrozenSlot } from "../slot";
import { createDataForSeo } from "./client";
import { exchange, recordOf, reportedCost, reportedTaskId } from "./live";
import { buildRequest, type DataForSeoRequest, requestBytes } from "./request";

type Clients = ReturnType<typeof createDataForSeo>;

type TaskEndpoints = {
  post: (clients: Clients, request: DataForSeoRequest) => Promise<unknown>;
  ready: (clients: Clients) => Promise<unknown>;
  get: (clients: Clients, id: string) => Promise<unknown>;
};

// buildRequest returns the request class of the engine's endpoint, so each cast only names it.
export const TASKS: Partial<Record<EngineId, TaskEndpoints>> = {
  gemini: {
    post: (c, r) =>
      c.ai.geminiLlmScraperTaskPost([r as AiOptimizationGeminiLlmScraperTaskPostRequestInfo]),
    ready: (c) => c.ai.geminiLlmScraperTasksReady(),
    get: (c, id) => c.ai.geminiLlmScraperTaskGetAdvanced(id),
  },
  chatgpt: {
    post: (c, r) =>
      c.ai.chatGptLlmScraperTaskPost([r as AiOptimizationChatGptLlmScraperTaskPostRequestInfo]),
    ready: (c) => c.ai.chatGptLlmScraperTasksReady(),
    get: (c, id) => c.ai.chatGptLlmScraperTaskGetAdvanced(id),
  },
  "google-ai-overview": {
    post: (c, r) => c.serp.googleOrganicTaskPost([r as SerpGoogleOrganicTaskPostRequestInfo]),
    ready: (c) => c.serp.googleOrganicTasksReady(),
    get: (c, id) => c.serp.googleOrganicTaskGetAdvanced(id),
  },
  "google-ai-mode": {
    post: (c, r) => c.serp.googleAiModeTaskPost([r as SerpGoogleAiModeTaskPostRequestInfo]),
    ready: (c) => c.serp.googleAiModeTasksReady(),
    get: (c, id) => c.serp.googleAiModeTaskGetAdvanced(id),
  },
};

function endpointsOf(engine: EngineId): TaskEndpoints {
  const endpoints = TASKS[engine];
  if (!endpoints) throw new InvalidInputError(`${engine} has no DataForSEO task endpoints`);
  return endpoints;
}

const TasksReady = z.object({
  tasks: z.array(
    z.object({
      result: z.array(z.object({ id: z.string(), tag: z.string().nullish() })).nullish(),
    }),
  ),
});

/**
 * Queues one slot on the Standard queue, one task per call so that each capture's sealed request
 * is exactly the task as posted. The task is billed here; its result is fetched for free.
 */
export async function postTask(slot: FrozenSlot): Promise<PostedTask> {
  const { post } = endpointsOf(slot.engine);
  const request = buildRequest(slot, "task");
  const sink = new RawSink();
  const clients = createDataForSeo(sink);
  const { outcome, body, timedOut } = await exchange(sink, () => post(clients, request));
  return {
    providerTaskId: outcome.ok ? reportedTaskId(body) : null,
    cost: timedOut ? null : reportedCost(body),
    error: outcome.ok ? null : outcome.error,
  };
}

async function collectTask(
  slot: FrozenSlot,
  id: string,
  parse: (bytes: Uint8Array) => EngineAnswer,
): Promise<CaptureRecord> {
  const { get } = endpointsOf(slot.engine);
  const sink = new RawSink();
  const clients = createDataForSeo(sink);
  const sent = await exchange(sink, () => get(clients, id));
  // The GET carries no body: the request sealed is the task as it was posted, rebuilt byte for
  // byte from the frozen slot.
  return recordOf(slot, { ...sent, request: requestBytes(slot, "task") }, parse, "task");
}

/**
 * Finished tasks of `slots`, found by their tag. The account is shared with other measurements
 * and environments, so a task whose tag is not one of these slot ids is never fetched.
 */
export async function collectReady(
  slots: readonly FrozenSlot[],
  parserOf: (engine: EngineId) => (bytes: Uint8Array) => EngineAnswer,
): Promise<ReadyTask[]> {
  const bySlotId = new Map<string, FrozenSlot>(slots.map((slot) => [slot.slotId, slot]));
  const engines = [...new Set(slots.map((slot) => slot.engine))];
  const listed = await Promise.all(
    engines.map(async (engine) => {
      const { ready } = endpointsOf(engine);
      const sink = new RawSink();
      const clients = createDataForSeo(sink);
      const { outcome, body } = await exchange(sink, () => ready(clients));
      if (!outcome.ok) throw outcome.error;
      const parsed = TasksReady.safeParse(body);
      const results = parsed.success ? parsed.data.tasks.flatMap((task) => task.result ?? []) : [];
      return results.flatMap(({ id, tag }): ReadyTask[] => {
        const slot = tag ? bySlotId.get(tag) : undefined;
        if (!slot || slot.engine !== engine) return [];
        const parse = parserOf(engine);
        return [{ slot, providerTaskId: id, collect: () => collectTask(slot, id, parse) }];
      });
    }),
  );
  return listed.flat();
}
