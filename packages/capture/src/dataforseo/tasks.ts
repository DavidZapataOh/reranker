import { InvalidInputError } from "@reranker/jobs/errors";
import { type EngineId, z } from "@reranker/schema";
import {
  type AiOptimizationChatGptLlmScraperTaskPostRequestInfo,
  type AiOptimizationGeminiLlmScraperTaskPostRequestInfo,
  type SerpGoogleAiModeTaskPostRequestInfo,
  type SerpGoogleOrganicTaskPostRequestInfo,
  SerpIdListRequestInfo,
} from "dataforseo-client";
import type { CaptureRecord, FoundTask, PostedTask, ReadyTask } from "../adapters";
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

// The task exists but has not run yet: there is nothing to seal.
const NOT_FINISHED = new Set([40601, 40602]);

/** Fetches a task's result by id, which DataForSEO keeps for 30 days; null until it has run. */
export async function collectTask(
  slot: FrozenSlot,
  id: string,
  parse: (bytes: Uint8Array) => EngineAnswer,
): Promise<CaptureRecord | null> {
  const { get } = endpointsOf(slot.engine);
  const sink = new RawSink();
  const clients = createDataForSeo(sink);
  const sent = await exchange(sink, () => get(clients, id));
  // The GET carries no body: the request sealed is the task as it was posted, rebuilt byte for
  // byte from the frozen slot.
  const record = recordOf(slot, { ...sent, request: requestBytes(slot, "task") }, parse, "task");
  return NOT_FINISHED.has(record.providerStatusCode ?? 0) ? null : record;
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

// id_list is paged by 1000 and answers at most 10 calls a minute.
const ID_LIST_LIMIT = 1000;

const IdList = z.object({
  tasks: z.array(
    z.object({
      result: z
        .array(
          z.object({
            id: z.string(),
            cost: z.number().nullish(),
            metadata: z.object({ tag: z.string().nullish() }).nullish(),
          }),
        )
        .nullish(),
    }),
  ),
});

// "yyyy-mm-dd hh:mm:ss +00:00", the format id_list takes.
const utc = (date: Date) => `${date.toISOString().slice(0, 19).replace("T", " ")} +00:00`;

type IdListRequest = {
  datetime_from: string;
  datetime_to: string;
  limit: number;
  offset: number;
  sort: "asc";
  include_metadata: true;
};

// SERP tasks are listed by the official client; AI Optimization's id_list
// (https://docs.dataforseo.com/v3/appendix/id_list/) is not wrapped, so it is posted the way the
// client posts SERP's: the same body, headers and recording fetch.
const ID_LISTS = {
  serp: (c: Clients, body: IdListRequest) => c.serp.idList([new SerpIdListRequestInfo(body)]),
  ai_optimization: (c: Clients, body: IdListRequest) =>
    c.http.fetch(`${c.http.base}/v3/ai_optimization/id_list`, {
      method: "POST",
      body: JSON.stringify([body]),
      headers: { "Content-Type": "application/json", Accept: "application/json" },
    }),
} as const;

const apiOf = (engine: EngineId): keyof typeof ID_LISTS =>
  engine === "gemini" || engine === "chatgpt" ? "ai_optimization" : "serp";

/**
 * Tasks of `slots` that DataForSEO created within `window`, finished or not, matched by tag. It
 * pages through every task of the account in the window, so the window should be minutes wide.
 */
export async function findTasks(
  slots: readonly FrozenSlot[],
  window: { from: Date; to: Date },
): Promise<FoundTask[]> {
  const bySlotId = new Map<string, FrozenSlot>(slots.map((slot) => [slot.slotId, slot]));
  const apis = [...new Set(slots.map((slot) => apiOf(slot.engine)))];
  // The end may not lie in the future.
  const to = new Date(Math.min(window.to.getTime(), Date.now()));
  const found: FoundTask[] = [];
  for (const api of apis) {
    for (let offset = 0; ; offset += ID_LIST_LIMIT) {
      const sink = new RawSink();
      const clients = createDataForSeo(sink);
      const request: IdListRequest = {
        datetime_from: utc(window.from),
        datetime_to: utc(to),
        limit: ID_LIST_LIMIT,
        offset,
        sort: "asc",
        include_metadata: true,
      };
      const { outcome, body } = await exchange(sink, () => ID_LISTS[api](clients, request));
      if (!outcome.ok) throw outcome.error;
      const parsed = IdList.safeParse(body);
      const results = parsed.success ? parsed.data.tasks.flatMap((task) => task.result ?? []) : [];
      for (const { id, cost, metadata } of results) {
        const slot = metadata?.tag ? bySlotId.get(metadata.tag) : undefined;
        if (!slot || apiOf(slot.engine) !== api) continue;
        const charged = typeof cost === "number" ? reportedCost({ cost }) : null;
        found.push({ slot, providerTaskId: id, cost: charged });
      }
      if (results.length < ID_LIST_LIMIT) break;
    }
  }
  return found;
}
