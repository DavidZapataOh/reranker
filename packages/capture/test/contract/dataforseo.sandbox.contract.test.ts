import { mkdirSync, writeFileSync } from "node:fs";
import { resetAppEnv } from "@reranker/env";
import { requireEnv } from "@reranker/testing/env";
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
import { beforeAll, describe, expect, test, vi } from "vitest";
import { createDataForSeo } from "../../src/dataforseo/client";
import { RawSink } from "../../src/raw/raw-sink";

// The sandbox is free and answers every endpoint with dummy data in the production shape
// (https://docs.dataforseo.com/v3/appendix/sandbox/). Each run rewrites the recordings, which the
// parser tests read as real wire bytes.
const RECORDED = new URL("../fixtures/recorded/sandbox/", import.meta.url);
const OK = 20000;
const TASK_CREATED = 20100;

const query = { keyword: "mejor odontólogo en Medellín", location_code: 2170, language_code: "es" };
const mobile = { ...query, device: "mobile", os: "android" };

type Task = { id?: string | undefined; status_code?: number | undefined };
type Wire = { status_code?: number | undefined; tasks?: Task[] | undefined };
type Envelope = Wire | null;
type Clients = ReturnType<typeof createDataForSeo>;

interface Endpoint {
  live: (c: Clients, tag: string) => Promise<Envelope>;
  post: (c: Clients, tag: string) => Promise<Envelope>;
  ready: (c: Clients) => Promise<Envelope>;
  get: (c: Clients, id: string) => Promise<Envelope>;
}

const ENDPOINTS: Record<string, Endpoint> = {
  chatgpt: {
    live: (c, tag) =>
      c.ai.chatGptLlmScraperLiveAdvanced([
        new AiOptimizationChatGptLlmScraperLiveAdvancedRequestInfo({
          ...query,
          force_web_search: true,
          tag,
        }),
      ]),
    post: (c, tag) =>
      c.ai.chatGptLlmScraperTaskPost([
        new AiOptimizationChatGptLlmScraperTaskPostRequestInfo({
          ...query,
          force_web_search: true,
          tag,
        }),
      ]),
    ready: (c) => c.ai.chatGptLlmScraperTasksReady(),
    get: (c, id) => c.ai.chatGptLlmScraperTaskGetAdvanced(id),
  },
  gemini: {
    live: (c, tag) =>
      c.ai.geminiLlmScraperLiveAdvanced([
        new AiOptimizationGeminiLlmScraperLiveAdvancedRequestInfo({ ...query, tag }),
      ]),
    post: (c, tag) =>
      c.ai.geminiLlmScraperTaskPost([
        new AiOptimizationGeminiLlmScraperTaskPostRequestInfo({ ...query, tag }),
      ]),
    ready: (c) => c.ai.geminiLlmScraperTasksReady(),
    get: (c, id) => c.ai.geminiLlmScraperTaskGetAdvanced(id),
  },
  "ai-overview": {
    live: (c, tag) =>
      c.serp.googleOrganicLiveAdvanced([
        new SerpGoogleOrganicLiveAdvancedRequestInfo({
          ...mobile,
          load_async_ai_overview: true,
          tag,
        }),
      ]),
    post: (c, tag) =>
      c.serp.googleOrganicTaskPost([
        new SerpGoogleOrganicTaskPostRequestInfo({ ...mobile, load_async_ai_overview: true, tag }),
      ]),
    ready: (c) => c.serp.googleOrganicTasksReady(),
    get: (c, id) => c.serp.googleOrganicTaskGetAdvanced(id),
  },
  "ai-mode": {
    live: (c, tag) =>
      c.serp.googleAiModeLiveAdvanced([
        new SerpGoogleAiModeLiveAdvancedRequestInfo({ ...mobile, tag }),
      ]),
    post: (c, tag) =>
      c.serp.googleAiModeTaskPost([new SerpGoogleAiModeTaskPostRequestInfo({ ...mobile, tag })]),
    ready: (c) => c.serp.googleAiModeTasksReady(),
    get: (c, id) => c.serp.googleAiModeTaskGetAdvanced(id),
  },
};

beforeAll(() => {
  // The env helpers read APP_ENV, which the contract job does not set.
  vi.stubEnv("APP_ENV", process.env.APP_ENV || "development");
  resetAppEnv();
  requireEnv("DATAFORSEO_LOGIN");
  requireEnv("DATAFORSEO_PASSWORD");
  mkdirSync(RECORDED, { recursive: true });
});

// Status code and message only: enough to tell which endpoint the sandbox refused, and why.
function refusal(sink: RawSink): string {
  const text = Buffer.from(sink.response ?? []).toString();
  try {
    const { status_code, status_message } = JSON.parse(text) as Record<string, unknown>;
    return `HTTP ${sink.status}, ${status_code}: ${status_message}`;
  } catch {
    return `HTTP ${sink.status}, ${sink.contentType ?? "no"} body`;
  }
}

/** Records the call's bytes and checks the client parsed exactly those bytes. */
async function recorded(sink: RawSink, name: string, call: Promise<Envelope>): Promise<Wire> {
  const parsed = await call.catch((error: unknown) => {
    throw new Error(`${name}: ${refusal(sink)}`, { cause: error });
  });
  const bytes = sink.response;
  if (!bytes) throw new Error(`${name}: the sink holds no response`);
  writeFileSync(new URL(`${name}.json`, RECORDED), bytes);
  const wire = JSON.parse(Buffer.from(bytes).toString()) as Wire;
  expect(wire.status_code, `${name}: ${refusal(sink)}`).toBe(OK);
  expect(parsed?.status_code).toBe(wire.status_code);
  expect(parsed?.tasks?.[0]?.id).toBe(wire.tasks?.[0]?.id);
  return wire;
}

describe.each(Object.entries(ENDPOINTS))("%s", (engine, endpoint) => {
  test("a Live call answers 20000 and the sink holds its exact bytes", async () => {
    const sink = new RawSink();
    const clients = createDataForSeo(sink, { base: "sandbox" });
    const wire = await recorded(
      sink,
      `${engine}-live`,
      endpoint.live(clients, `contract:${engine}`),
    );
    expect(wire.tasks?.[0]?.status_code).toBe(OK);
    expect(JSON.parse(Buffer.from(sink.request ?? []).toString())).toEqual([
      expect.objectContaining({ keyword: query.keyword, tag: `contract:${engine}` }),
    ]);
  });

  test("task_post, tasks_ready and task_get/advanced answer 20000", async () => {
    const sink = new RawSink();
    const clients = createDataForSeo(sink, { base: "sandbox" });
    const posted = await recorded(
      sink,
      `${engine}-task-post`,
      endpoint.post(clients, `contract:${engine}`),
    );
    expect(posted.tasks?.[0]?.status_code).toBe(TASK_CREATED);
    const id = posted.tasks?.[0]?.id;
    if (!id) throw new Error(`${engine}: task_post returned no task id`);
    await recorded(sink, `${engine}-tasks-ready`, endpoint.ready(clients));
    const got = await recorded(sink, `${engine}-task-get`, endpoint.get(clients, id));
    expect(got.tasks?.[0]?.status_code).toBe(OK);
    expect(sink.calls).toBe(3);
  });
});
