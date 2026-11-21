import { readFileSync } from "node:fs";
import { geoForEngine, getGeo } from "@reranker/catalog";
import { resetAppEnv } from "@reranker/env";
import { InvalidInputError, ProviderRejectedError, ProviderUnavailableError } from "@reranker/jobs";
import type { EngineId } from "@reranker/schema";
import { server } from "@reranker/testing/msw";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { dataforseoAdapter } from "../../src/dataforseo/adapter";
import { batchRequestBytes, postTasks } from "../../src/dataforseo/tasks";
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

describe("postTasks", () => {
  type Answer = { tag: string; id: string; status: number };
  /** The sandbox's task_post answer, one task per entry, with production ids, tags and costs. */
  function postedMany(tasks: Answer[], envelope = 20000): string {
    const body = JSON.parse(recorded("ai-mode-task-post"));
    const [template] = body.tasks;
    body.status_code = envelope;
    body.cost = 0.0012 * tasks.length;
    body.tasks = tasks.map(({ tag, id, status }) => ({
      ...template,
      id,
      status_code: status,
      cost: status === 20100 ? 0.0012 : 0,
      data: { ...template.data, tag },
    }));
    return JSON.stringify(body);
  }

  test("posts up to 100 slots in one call and reads each task by its tag", async () => {
    const slots = [0, 1, 2].map((i) => slot("google-ai-mode", i));
    const bodies: Uint8Array[] = [];
    server.use(
      http.post(`${AI_MODE}/task_post`, async ({ request }) => {
        bodies.push(new Uint8Array(await request.arrayBuffer()));
        // Answered out of order: the tag, not the position, names the slot.
        return json(
          postedMany([
            { tag: slots[2]?.slotId ?? "", id: "t-2", status: 20100 },
            { tag: slots[0]?.slotId ?? "", id: "t-0", status: 20100 },
            { tag: slots[1]?.slotId ?? "", id: "", status: 40501 },
          ]),
        );
      }),
    );
    const { tasks } = await postTasks(slots);
    expect(bodies).toHaveLength(1);
    expect(Buffer.from(bodies[0] as Uint8Array).equals(batchRequestBytes(slots))).toBe(true);
    expect(
      tasks.map((t) => [t.slot.slotId, t.status, t.providerTaskId, t.cost?.amount_micros]),
    ).toEqual([
      [slots[0]?.slotId, "accepted", "t-0", 1200],
      [slots[1]?.slotId, "refused", null, 0],
      [slots[2]?.slotId, "accepted", "t-2", 1200],
    ]);
    expect(tasks[1]?.error).toBeInstanceOf(ProviderRejectedError);
  });

  test("a call refused whole refuses every task", async () => {
    server.use(http.post(`${AI_MODE}/task_post`, () => json(postedMany([], 40210))));
    const { tasks } = await postTasks([slot("google-ai-mode", 0), slot("google-ai-mode", 1)]);
    expect(tasks.map((t) => t.status)).toEqual(["refused", "refused"]);
    expect(tasks[0]?.error).toBeInstanceOf(ProviderRejectedError);
  });

  test("an answer that does not tell whether the tasks exist throws ProviderUnavailable", async () => {
    server.use(http.post(`${AI_MODE}/task_post`, () => json(postedMany([], 50000))));
    await expect(postTasks([slot("google-ai-mode", 0)])).rejects.toBeInstanceOf(
      ProviderUnavailableError,
    );
    server.use(http.post(`${AI_MODE}/task_post`, () => new HttpResponse("<html>502</html>")));
    await expect(postTasks([slot("google-ai-mode", 0)])).rejects.toBeInstanceOf(
      ProviderUnavailableError,
    );
  });

  test.each([
    ["gemini", "*/v3/ai_optimization/gemini/llm_scraper"],
    ["chatgpt", "*/v3/ai_optimization/chat_gpt/llm_scraper"],
    ["google-ai-overview", "*/v3/serp/google/organic"],
  ] as const)("%s posts, lists and fetches on its own endpoints", async (engine, base) => {
    const target = slot(engine, 0);
    server.use(
      http.post(`${base}/task_post`, () =>
        json(postedMany([{ tag: target.slotId, id: "t-0", status: 20100 }])),
      ),
      http.get(`${base}/tasks_ready`, () => json(ready([{ id: "t-0", tag: target.slotId }]))),
      http.get(`${base}/task_get/advanced/:id`, () =>
        json(JSON.stringify({ status_code: 20000, tasks: [{ id: "t-0", status_code: 40602 }] })),
      ),
    );
    const { tasks } = await postTasks([target]);
    expect(tasks[0]).toMatchObject({ status: "accepted", providerTaskId: "t-0" });
    const ready_ = await dataforseoAdapter.collectReady?.([target]);
    expect(ready_?.map((t) => t.providerTaskId)).toEqual(["t-0"]);
    await expect(dataforseoAdapter.collectTask?.(target, "t-0", [target])).resolves.toBeNull();
  });

  test("a task answered with a server error is unknown", async () => {
    const target = slot("google-ai-mode", 0);
    server.use(
      http.post(`${AI_MODE}/task_post`, () =>
        json(postedMany([{ tag: target.slotId, id: "", status: 50000 }])),
      ),
    );
    const { tasks } = await postTasks([target]);
    expect(tasks[0]?.status).toBe("unknown");
  });

  test("a task missing from the answer is unknown", async () => {
    const slots = [slot("google-ai-mode", 0), slot("google-ai-mode", 1)];
    server.use(
      http.post(`${AI_MODE}/task_post`, () =>
        json(postedMany([{ tag: slots[0]?.slotId ?? "", id: "t-0", status: 20100 }])),
      ),
    );
    const { tasks } = await postTasks(slots);
    expect(tasks.map((t) => t.status)).toEqual(["accepted", "unknown"]);
  });

  test("a call carries 1 to 100 tasks of one engine", async () => {
    await expect(postTasks([])).rejects.toBeInstanceOf(InvalidInputError);
    const many = Array.from({ length: 101 }, (_, i) => slot("google-ai-mode", i));
    await expect(postTasks(many)).rejects.toBeInstanceOf(InvalidInputError);
    await expect(postTasks([slot("google-ai-mode", 0), slot("gemini", 1)])).rejects.toBeInstanceOf(
      InvalidInputError,
    );
    await expect(postTasks([slot("perplexity", 0)])).rejects.toBeInstanceOf(InvalidInputError);
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

  test("collectTask fetches the result and seals the task_post that created it", async () => {
    const target = mine[0] as FrozenSlot;
    const batch = [mine[1] as FrozenSlot, target];
    const got = recorded("ai-mode-task-get");
    server.use(
      http.get(`${AI_MODE}/task_get/advanced/:id`, ({ params }) =>
        params.id === "t-0" ? json(got) : new HttpResponse(null, { status: 404 }),
      ),
    );
    const record = await dataforseoAdapter.collectTask?.(target, "t-0", batch);
    expect(record).toMatchObject({
      slot: target,
      status: "succeeded",
      mode: "task",
      cost: null,
      providerTaskId: JSON.parse(got).tasks[0].id,
      parseError: null,
    });
    expect(record?.endpoint).toMatch(/\/v3\/serp\/google\/ai_mode\/task_get\/advanced\/t-0$/);
    expect(Buffer.from(record?.request ?? []).equals(batchRequestBytes(batch))).toBe(true);
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
    const target = slot("google-ai-mode", 0);
    await expect(dataforseoAdapter.collectTask?.(target, "t-0", [target])).resolves.toBe(null);
  });

  test("a finished task is fetched by id", async () => {
    server.use(
      http.get(`${AI_MODE}/task_get/advanced/:id`, () => json(recorded("ai-mode-task-get"))),
    );
    const target = slot("google-ai-mode", 0);
    const record = await dataforseoAdapter.collectTask?.(target, "t-0", [target]);
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
