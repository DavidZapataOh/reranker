import { readFileSync } from "node:fs";
import { geoForEngine, getGeo } from "@reranker/catalog";
import { resetAppEnv } from "@reranker/env";
import { InvalidInputError, ProviderRejectedError } from "@reranker/jobs";
import type { EngineId } from "@reranker/schema";
import { server } from "@reranker/testing/msw";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { dataforseoAdapter } from "../../src/dataforseo/adapter";
import { requestBytes } from "../../src/dataforseo/request";
import { postTask } from "../../src/dataforseo/tasks";
import { type FrozenSlot, slotId } from "../../src/slot";

vi.mock("@reranker/jobs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@reranker/jobs")>()),
  breakerRecord: vi.fn(async () => {}),
}));

const MEASUREMENT = "0193b6f2-7c1e-7a51-9b3a-5f2e8d4c1a90";
const OTHER = "0193b6f2-7c1e-7a51-9b3a-000000000000";
const AI_MODE = "*/v3/serp/google/ai_mode";

const recorded = (name: string) =>
  readFileSync(new URL(`../fixtures/recorded/sandbox/${name}.json`, import.meta.url), "utf8");

function slot(engine: EngineId, slotIndex: number): FrozenSlot {
  const geoKey = "co-c1003654";
  const geoDeclared = geoForEngine(engine, getGeo(geoKey), "local", { provider: "dataforseo" });
  if (!geoDeclared) throw new Error(`${engine} is not offered in ${geoKey}`);
  return {
    engine,
    provider: "dataforseo",
    intentSetId: "is_0123456789abcdef",
    intentId: "dental_clinic.best",
    paraphraseId: "p1",
    geoKey,
    geoDeclared,
    runIndex: 0,
    promptText: "¿Cuál es el mejor odontólogo cerca de mí?",
    measurementId: MEASUREMENT,
    slotIndex,
    slotId: slotId(MEASUREMENT, slotIndex),
  };
}

/** The sandbox's task_post answer, with the id, tag and cost of a production task. */
function posted(id: string, tag: string, statusCode = 20100): string {
  const body = JSON.parse(recorded("ai-mode-task-post"));
  body.cost = 0.0012;
  Object.assign(body.tasks[0], { id, status_code: statusCode, cost: 0.0012 });
  body.tasks[0].data.tag = tag;
  return JSON.stringify(body);
}

/** The sandbox's tasks_ready answer, listing the given tasks. */
function ready(tasks: Array<{ id: string; tag: string }>): string {
  const body = JSON.parse(recorded("ai-mode-tasks-ready"));
  const [template] = body.tasks[0].result;
  body.tasks[0].result = tasks.map(({ id, tag }) => ({ ...template, id, tag }));
  body.tasks[0].result_count = tasks.length;
  return JSON.stringify(body);
}

const json = (body: string) =>
  new HttpResponse(body, { headers: { "content-type": "application/json" } });

beforeAll(() => server.listen());
beforeEach(() => {
  vi.stubEnv("APP_ENV", "development");
  vi.stubEnv("DATAFORSEO_LOGIN", "capture-unit@example.com");
  vi.stubEnv("DATAFORSEO_PASSWORD", "capture-unit-password");
  resetAppEnv();
});
afterEach(() => {
  server.resetHandlers();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  resetAppEnv();
});
afterAll(() => server.close());

describe("postTask", () => {
  test("posts the slot as one tagged task and returns its id and billed cost", async () => {
    const target = slot("google-ai-mode", 2);
    const bodies: Uint8Array[] = [];
    server.use(
      http.post(`${AI_MODE}/task_post`, async ({ request }) => {
        bodies.push(new Uint8Array(await request.arrayBuffer()));
        return json(posted("task-1", target.slotId));
      }),
    );
    const out = await postTask(target);
    expect(out).toEqual({
      providerTaskId: "task-1",
      cost: { amount_micros: 1200, currency: "USD" },
      error: null,
    });
    expect(bodies).toHaveLength(1);
    expect(Buffer.from(bodies[0] as Uint8Array).equals(requestBytes(target, "task"))).toBe(true);
    expect(JSON.parse(new TextDecoder().decode(bodies[0]))[0].tag).toBe(target.slotId);
  });

  test("a refused task returns the provider's error and no id", async () => {
    server.use(http.post(`${AI_MODE}/task_post`, () => json(posted("", "x", 40210))));
    const out = await postTask(slot("google-ai-mode", 0));
    expect(out.providerTaskId).toBeNull();
    expect(out.error).toBeInstanceOf(ProviderRejectedError);
  });

  test("an engine without task endpoints is an input error", async () => {
    await expect(postTask(slot("perplexity", 0))).rejects.toBeInstanceOf(InvalidInputError);
  });
});

describe("collectReady", () => {
  const mine = [slot("google-ai-mode", 0), slot("google-ai-mode", 1), slot("gemini", 2)];

  test("lists only tasks tagged with one of the slots, on the slot's own engine", async () => {
    server.use(
      http.get(`${AI_MODE}/tasks_ready`, () =>
        json(
          ready([
            { id: "t-0", tag: mine[0]?.slotId ?? "" },
            { id: "t-other", tag: `${OTHER}:0` },
            { id: "t-untagged", tag: "" },
            { id: "t-foreign", tag: "user_tag=2" },
            // Slot 2 is a Gemini slot: an AI Mode task cannot be its capture.
            { id: "t-wrong-engine", tag: mine[2]?.slotId ?? "" },
          ]),
        ),
      ),
      http.get("*/v3/ai_optimization/gemini/llm_scraper/tasks_ready", () => json(ready([]))),
    );
    const tasks = await dataforseoAdapter.collectReady?.(mine);
    expect(tasks?.map((t) => [t.slot.slotId, t.providerTaskId])).toEqual([
      [mine[0]?.slotId, "t-0"],
    ]);
  });

  test("collect fetches the result and seals the task as it was posted", async () => {
    const target = mine[0] as FrozenSlot;
    const got = recorded("ai-mode-task-get");
    server.use(
      http.get(`${AI_MODE}/tasks_ready`, () => json(ready([{ id: "t-0", tag: target.slotId }]))),
      http.get(`${AI_MODE}/task_get/advanced/:id`, ({ params }) =>
        params.id === "t-0" ? json(got) : new HttpResponse(null, { status: 404 }),
      ),
    );
    const [task] = (await dataforseoAdapter.collectReady?.([target])) ?? [];
    const record = await task?.collect();
    expect(record).toMatchObject({
      slot: target,
      status: "succeeded",
      mode: "task",
      cost: null,
      providerTaskId: JSON.parse(got).tasks[0].id,
      parseError: null,
    });
    expect(record?.endpoint).toMatch(/\/v3\/serp\/google\/ai_mode\/task_get\/advanced\/t-0$/);
    expect(Buffer.from(record?.request ?? []).equals(requestBytes(target, "task"))).toBe(true);
    expect(Buffer.from(record?.response ?? []).equals(Buffer.from(got))).toBe(true);
    expect(record?.answer?.engine).toBe("google-ai-mode");
  });

  test("a refused listing throws its error", async () => {
    server.use(
      http.get(`${AI_MODE}/tasks_ready`, () => json(JSON.stringify({ status_code: 40210 }))),
    );
    await expect(dataforseoAdapter.collectReady?.([mine[0] as FrozenSlot])).rejects.toBeInstanceOf(
      ProviderRejectedError,
    );
  });
});

describe("collectTask", () => {
  test.each([40601, 40602])("a task still queued (%i) has nothing to seal", async (code) => {
    server.use(
      http.get(`${AI_MODE}/task_get/advanced/:id`, () =>
        json(JSON.stringify({ status_code: 20000, tasks: [{ id: "t-0", status_code: code }] })),
      ),
    );
    await expect(dataforseoAdapter.collectTask?.(slot("google-ai-mode", 0), "t-0")).resolves.toBe(
      null,
    );
  });

  test("a finished task is fetched by id", async () => {
    server.use(
      http.get(`${AI_MODE}/task_get/advanced/:id`, () => json(recorded("ai-mode-task-get"))),
    );
    const record = await dataforseoAdapter.collectTask?.(slot("google-ai-mode", 0), "t-0");
    expect(record).toMatchObject({ status: "succeeded", mode: "task" });
  });
});

describe("findTasks", () => {
  type Listed = { id: string; tag: string; cost?: number };
  const page = (tasks: Listed[]) =>
    json(
      JSON.stringify({
        status_code: 20000,
        tasks: [
          {
            status_code: 20000,
            result: tasks.map(({ id, tag, cost }) => ({
              id,
              datetime_posted: "2026-11-20 10:00:01 +00:00",
              status: "Ok.",
              cost: cost ?? 0.0012,
              metadata: { tag, keyword: "x" },
            })),
          },
        ],
      }),
    );

  test("pages through SERP and AI Optimization id lists and matches each slot by its tag", async () => {
    const serpSlot = slot("google-ai-mode", 0);
    const aiSlot = slot("gemini", 1);
    const bodies: Array<{ api: string; body: Record<string, unknown> }> = [];
    const full = Array.from({ length: 1000 }, (_, i) => ({
      id: `other-${i}`,
      tag: `${OTHER}:${i}`,
    }));
    for (const api of ["serp", "ai_optimization"]) {
      server.use(
        http.post(`*/v3/${api}/id_list`, async ({ request }) => {
          const [body] = (await request.json()) as Array<Record<string, unknown>>;
          bodies.push({ api, body: body ?? {} });
          if (api === "ai_optimization") return page([{ id: "ai-1", tag: aiSlot.slotId }]);
          return body?.offset === 0 ? page(full) : page([{ id: "serp-1", tag: serpSlot.slotId }]);
        }),
      );
    }
    const found = await dataforseoAdapter.findTasks?.([serpSlot, aiSlot], {
      from: new Date("2026-11-20T10:00:00Z"),
      to: new Date("2026-11-20T10:05:00Z"),
    });
    expect(found?.map((t) => [t.slot.slotId, t.providerTaskId, t.cost?.amount_micros])).toEqual([
      [serpSlot.slotId, "serp-1", 1200],
      [aiSlot.slotId, "ai-1", 1200],
    ]);
    expect(bodies.map(({ api, body }) => [api, body.offset])).toEqual([
      ["serp", 0],
      ["serp", 1000],
      ["ai_optimization", 0],
    ]);
    expect(bodies[0]?.body).toEqual({
      datetime_from: "2026-11-20 10:00:00 +00:00",
      datetime_to: "2026-11-20 10:05:00 +00:00",
      limit: 1000,
      offset: 0,
      sort: "asc",
      include_metadata: true,
    });
  });

  test("a refused id list throws its error", async () => {
    server.use(http.post("*/v3/serp/id_list", () => json(JSON.stringify({ status_code: 40210 }))));
    await expect(
      dataforseoAdapter.findTasks?.([slot("google-ai-mode", 0)], {
        from: new Date(Date.now() - 60_000),
        to: new Date(Date.now() + 60_000),
      }),
    ).rejects.toBeInstanceOf(ProviderRejectedError);
  });
});
