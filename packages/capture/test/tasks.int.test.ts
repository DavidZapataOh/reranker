import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { withSystem } from "@reranker/db";
import { releaseSpend } from "@reranker/jobs";
import type { EngineId } from "@reranker/schema";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { collectReadyTasks, postCaptureTasks } from "../src/queue";
import {
  fixture,
  frozen,
  installCaptureHarness,
  ledger,
  provider,
  r2,
  rowsOf,
  statementOf,
} from "./support/capture-harness";

vi.mock("../../evidence/src/signer", () => ({ loadSigner: vi.fn() }));
vi.mock("@reranker/jobs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@reranker/jobs")>()),
  enqueue: vi.fn(async () => ({ jobId: "evidence.integrate:test", created: true })),
}));
const switchedOff = vi.hoisted(() => new Set<string>());
vi.mock("@reranker/flags", async (importOriginal) => {
  const flags = await importOriginal<typeof import("@reranker/flags")>();
  return {
    ...flags,
    assertCaptureAllowed: vi.fn(async (input: Record<string, string>) => {
      const keys = ["channel", "provider", "engine"]
        .map((kind) => `capture-${kind}-${input[kind]}`)
        .filter((key) => switchedOff.has(key));
      if (keys.length > 0) throw new flags.CaptureChannelDisabledError(keys as never);
    }),
  };
});

installCaptureHarness();

const ENDPOINTS: Array<[EngineId, string, Uint8Array, "serp" | "ai_optimization"]> = [
  [
    "gemini",
    "/v3/ai_optimization/gemini/llm_scraper/",
    fixture("recorded/live/gemini-dentistas-medellin.json"),
    "ai_optimization",
  ],
  [
    "google-ai-overview",
    "/v3/serp/google/organic/",
    fixture("recorded/live/ai-overview-pico-y-placa-medellin.json"),
    "serp",
  ],
  [
    "google-ai-mode",
    "/v3/serp/google/ai_mode/",
    fixture("recorded/live/ai-mode-dentistas-medellin.json"),
    "serp",
  ],
];

const sandbox = (name: string) =>
  JSON.parse(
    readFileSync(new URL(`./fixtures/recorded/sandbox/${name}.json`, import.meta.url), "utf8"),
  );

type Task = { id: string; engine: EngineId; tag: string; body: Uint8Array };

/** DataForSEO's Standard queue: tasks finish as soon as they are created. */
const queue = {
  /** Every task_post request that reached the provider. */
  posts: 0,
  created: [] as Task[],
  foreign: [] as Task[],
  fetched: [] as string[],
  /** The next post creates its task, then the connection drops before the answer. */
  dropAnswer: false,
  /** The next post fails before reaching the provider. */
  dropRequest: false,
};

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

function idList(api: "serp" | "ai_optimization"): Response {
  const engines = ENDPOINTS.filter((e) => e[3] === api).map((e) => e[0]);
  return json({
    status_code: 20000,
    tasks: [
      {
        status_code: 20000,
        result: [...queue.created, ...queue.foreign]
          .filter((t) => engines.includes(t.engine))
          .map(({ id, tag }) => ({ id, status: "Ok.", cost: 0.0012, metadata: { tag } })),
      },
    ],
  });
}

async function fakeQueue(request: Request): Promise<Response | null> {
  const { pathname } = new URL(request.url);
  if (pathname === "/v3/serp/id_list") return idList("serp");
  if (pathname === "/v3/ai_optimization/id_list") return idList("ai_optimization");
  const match = ENDPOINTS.find(([, path]) => pathname.startsWith(path));
  if (!match) return null;
  const [engine, path, answer] = match;
  const action = pathname.slice(path.length);
  if (action === "task_post") {
    if (queue.dropRequest) {
      queue.dropRequest = false;
      throw new TypeError("fetch failed");
    }
    queue.posts += 1;
    const body = new Uint8Array(await request.arrayBuffer());
    const id = randomUUID();
    const tag = JSON.parse(new TextDecoder().decode(body))[0].tag;
    queue.created.push({ id, engine, tag, body });
    if (queue.dropAnswer) {
      queue.dropAnswer = false;
      throw new TypeError("fetch failed");
    }
    const out = sandbox("ai-mode-task-post");
    out.cost = 0.0012;
    Object.assign(out.tasks[0], { id, cost: 0.0012 });
    return json(out);
  }
  if (action === "tasks_ready") {
    const out = sandbox("ai-mode-tasks-ready");
    const [template] = out.tasks[0].result;
    out.tasks[0].result = [...queue.created, ...queue.foreign]
      .filter((t) => t.engine === engine && !queue.fetched.includes(t.id))
      .map(({ id, tag }) => ({ ...template, id, tag }));
    return json(out);
  }
  const id = action.match(/^task_get\/advanced\/(.+)$/)?.[1];
  if (!id) return null;
  queue.fetched.push(id);
  return new Response(answer, { headers: { "content-type": "application/json" } });
}

const spend = (m: string) => ({
  spend: { purpose: "contract-test" as const, refType: "capture-test", refId: m },
});

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

const createdPerSlot = () => {
  const counts = new Map<string, number>();
  for (const t of queue.created) counts.set(t.tag, (counts.get(t.tag) ?? 0) + 1);
  return [...counts.values()];
};

async function settledMicros(m: string): Promise<number> {
  const { rows } = await withSystem("capture.test", (tx) =>
    tx.execute<{ total: string }>(
      sql`select coalesce(sum(actual_amount_micros), 0)::text as total from ops.spend_ledger
          where ref_type = 'capture-test' and ref_id = ${m} and status = 'settled'`,
    ),
  );
  return Number(rows[0]?.total);
}

/** Moves a measurement's task timestamps back, as the passing of time would. */
async function age(m: string, column: "posting_at" | "fetching_at", minutes: number) {
  await withSystem("capture.test", (tx) =>
    tx.execute(
      sql`update ops.capture_tasks set ${sql.identifier(column)} = ${sql.identifier(column)} - make_interval(mins => ${minutes})
          where measurement_id = ${m} and ${sql.identifier(column)} is not null`,
    ),
  );
}

async function openReservations(m: string): Promise<string[]> {
  const { rows } = await withSystem("capture.test", (tx) =>
    tx.execute<{ id: string }>(
      sql`select reservation_id::text as id from ops.capture_tasks
          where measurement_id = ${m} and vendor_task_id is null and reservation_id is not null`,
    ),
  );
  return rows.map((r) => r.id);
}

beforeEach(() => {
  switchedOff.clear();
  Object.assign(queue, {
    posts: 0,
    created: [],
    foreign: [],
    fetched: [],
    dropAnswer: false,
    dropRequest: false,
  });
  const harness = globalThis.fetch;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      if (new URL(request.url).hostname === "sandbox.dataforseo.com") {
        const answered = await fakeQueue(request);
        if (answered) return answered;
      }
      return harness(input, init);
    }),
  );
});

const cycle = (n: number) => Array.from({ length: n }, (_, i) => ENDPOINTS[i % 3]?.[0] as EngineId);

describe("postCaptureTasks", () => {
  test("posting 1,550 slots posts each once and settles the task_post cost", async () => {
    const { m, ids } = await frozen(cycle(1550));
    await expect(postCaptureTasks(m, ids, spend(m))).resolves.toEqual({ posted: 1550, failed: [] });
    expect(queue.created.map((t) => t.tag).sort()).toEqual([...ids].sort());
    expect(await ledger(m)).toEqual({ settled: 1550 });
    expect(await settledMicros(m)).toBe(1550 * 1200);
    // Claimed already: posting again pays nothing.
    await expect(postCaptureTasks(m, ids, spend(m))).resolves.toEqual({ posted: 0, failed: [] });
    expect(queue.posts).toBe(1550);
  }, 180_000);

  test("two processes posting the same plan at once post each slot exactly once", async () => {
    const { m, ids } = await frozen(cycle(30));
    const outs = await Promise.all([
      postCaptureTasks(m, ids, spend(m)),
      postCaptureTasks(m, ids, spend(m)),
    ]);
    expect(outs.flatMap((o) => o.failed)).toEqual([]);
    expect(outs.reduce((sum, o) => sum + o.posted, 0)).toBe(30);
    expect(queue.posts).toBe(30);
    expect(createdPerSlot()).toEqual(Array(30).fill(1));
    expect(await ledger(m)).toEqual({ settled: 30 });
  });

  test("a crash after the task was created recovers it by tag without a second charge", async () => {
    const { m, ids } = await frozen(cycle(3));
    queue.dropAnswer = true;
    const first = await postCaptureTasks(m, ids, spend(m));
    expect(first.posted).toBe(2);
    expect(first.failed.map((f) => f.code)).toEqual(["ProviderUnavailable"]);
    // The posting is still open: nobody posts it again before the lookup can decide.
    await expect(postCaptureTasks(m, ids, spend(m))).resolves.toEqual({ posted: 0, failed: [] });
    await age(m, "posting_at", 10);
    await expect(postCaptureTasks(m, ids, spend(m))).resolves.toEqual({ posted: 0, failed: [] });
    expect(queue.posts).toBe(3);
    expect(await ledger(m)).toEqual({ settled: 3 });
    expect(await settledMicros(m)).toBe(3 * 1200);
    await expect(collectReadyTasks(m)).resolves.toEqual({ collected: 3, pending: 0 });
  });

  test("a recovered task whose reservation the stale sweep released is charged once", async () => {
    const { m, ids } = await frozen(cycle(1));
    queue.dropAnswer = true;
    await postCaptureTasks(m, ids, spend(m));
    for (const id of await openReservations(m)) {
      await releaseSpend({
        id,
        reserved: { amount_micros: 1200, currency: "USD" },
        provider: "dataforseo",
        purpose: "contract-test",
        scopes: [],
      });
    }
    await age(m, "posting_at", 10);
    await postCaptureTasks(m, ids, spend(m));
    expect(queue.posts).toBe(1);
    expect(await ledger(m)).toEqual({ released: 1, settled: 1 });
    expect(await settledMicros(m)).toBe(1200);
  });

  test("a posting that never reached the provider frees the slot to be posted once", async () => {
    const { m, ids } = await frozen(cycle(3));
    queue.dropRequest = true;
    await postCaptureTasks(m, ids, spend(m));
    expect(queue.created).toHaveLength(2);
    await age(m, "posting_at", 10);
    await expect(postCaptureTasks(m, ids, spend(m))).resolves.toEqual({ posted: 1, failed: [] });
    expect(createdPerSlot()).toEqual([1, 1, 1]);
    expect(await ledger(m)).toEqual({ released: 1, settled: 3 });
    expect(await settledMicros(m)).toBe(3 * 1200);
  });

  test("a switched-off engine is not posted", async () => {
    const { m, ids } = await frozen(cycle(3));
    switchedOff.add("capture-engine-gemini");
    const out = await postCaptureTasks(m, ids, spend(m));
    expect(out).toEqual({
      posted: 2,
      failed: [{ slotId: ids[0], code: "CaptureChannelDisabled" }],
    });
    expect(queue.created.map((t) => t.engine).sort()).toEqual([
      "google-ai-mode",
      "google-ai-overview",
    ]);
  });
});

describe("collectReadyTasks", () => {
  test("collect ignores tasks of other measurements", async () => {
    const [{ m, ids }, other] = await Promise.all([frozen(cycle(3)), frozen(cycle(3))]);
    await postCaptureTasks(m, ids, spend(m));
    for (const [engine] of ENDPOINTS) {
      queue.foreign.push({ id: randomUUID(), engine, tag: `${other.m}:0`, body: new Uint8Array() });
      queue.foreign.push({ id: randomUUID(), engine, tag: "user_tag=2", body: new Uint8Array() });
    }
    await expect(collectReadyTasks(m)).resolves.toEqual({ collected: 3, pending: 0 });
    expect(queue.fetched.sort()).toEqual(queue.created.map((t) => t.id).sort());
    expect(await rowsOf(other.m)).toHaveLength(0);
  });

  test("collected captures are sealed with the posted request bytes", async () => {
    const { m, ids } = await frozen(cycle(3));
    await postCaptureTasks(m, ids, spend(m));
    await collectReadyTasks(m);
    const rows = await rowsOf(m);
    expect(rows.map((r) => [r.mode, r.status, r.cost_amount_micros])).toEqual(
      Array(3).fill(["task", "succeeded", 1200]),
    );
    for (const task of queue.created) {
      const row = rows.find((r) => `${m}:${r.slotIndex}` === task.tag);
      const statement = statementOf(row?.envelopeSha256 as Buffer);
      expect(statement.subject).toContainEqual({
        name: "request",
        digest: { sha256: sha256(task.body) },
      });
      expect(Buffer.from(r2.get(`request/${sha256(task.body)}`) ?? []).equals(task.body)).toBe(
        true,
      );
      expect(statement.predicate.engine).toMatchObject({
        mode: "task",
        vendor_task_id: task.id,
      });
    }
  });

  test("a store failure is recovered by fetching the task again by id, with no extra post", async () => {
    const { m, ids } = await frozen(cycle(3));
    await postCaptureTasks(m, ids, spend(m));
    provider.r2RefusesWrites = true;
    await expect(collectReadyTasks(m)).rejects.toThrow();
    provider.r2RefusesWrites = false;
    // Fetched once, so the provider no longer lists them as ready.
    await expect(collectReadyTasks(m)).resolves.toEqual({ collected: 0, pending: 3 });
    await age(m, "fetching_at", 5);
    await expect(collectReadyTasks(m)).resolves.toEqual({ collected: 3, pending: 0 });
    expect(queue.posts).toBe(3);
    expect(queue.fetched).toHaveLength(6);
    expect(await ledger(m)).toEqual({ settled: 3 });
  });

  test("pending counts slots without a succeeded capture", async () => {
    const { m, ids } = await frozen(cycle(5));
    await postCaptureTasks(m, ids.slice(0, 3), spend(m));
    await expect(collectReadyTasks(m, { max: 2 })).resolves.toEqual({ collected: 2, pending: 3 });
    await expect(collectReadyTasks(m)).resolves.toEqual({ collected: 1, pending: 2 });
  });

  test("collecting twice stores nothing new", async () => {
    const { m, ids } = await frozen(cycle(3));
    await postCaptureTasks(m, ids, spend(m));
    await collectReadyTasks(m);
    await expect(collectReadyTasks(m)).resolves.toEqual({ collected: 0, pending: 0 });
    expect(queue.fetched).toHaveLength(3);
    expect(await rowsOf(m)).toHaveLength(3);
  });
});
