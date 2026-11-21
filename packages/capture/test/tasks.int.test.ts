import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { withSystem } from "@reranker/db";
import type { EngineId } from "@reranker/schema";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { collectReadyTasks, postCaptureTasks } from "../src/capture";
import {
  fixture,
  frozen,
  installCaptureHarness,
  ledger,
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

const ENDPOINTS: Array<[EngineId, string, Uint8Array]> = [
  [
    "gemini",
    "/v3/ai_optimization/gemini/llm_scraper/",
    fixture("recorded/live/gemini-dentistas-medellin.json"),
  ],
  [
    "google-ai-overview",
    "/v3/serp/google/organic/",
    fixture("recorded/live/ai-overview-pico-y-placa-medellin.json"),
  ],
  [
    "google-ai-mode",
    "/v3/serp/google/ai_mode/",
    fixture("recorded/live/ai-mode-dentistas-medellin.json"),
  ],
];

const sandbox = (name: string) =>
  JSON.parse(
    readFileSync(new URL(`./fixtures/recorded/sandbox/${name}.json`, import.meta.url), "utf8"),
  );

type Task = { id: string; engine: EngineId; tag: string; body: Uint8Array };

/** DataForSEO's Standard queue: tasks finish as soon as they are posted. */
const queue = {
  posted: [] as Task[],
  foreign: [] as Task[],
  fetched: [] as string[],
};

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

async function fakeQueue(request: Request): Promise<Response | null> {
  const { pathname } = new URL(request.url);
  const match = ENDPOINTS.find(([, path]) => pathname.startsWith(path));
  if (!match) return null;
  const [engine, path, answer] = match;
  const action = pathname.slice(path.length);
  if (action === "task_post") {
    const body = new Uint8Array(await request.arrayBuffer());
    const id = randomUUID();
    const tag = JSON.parse(new TextDecoder().decode(body))[0].tag;
    queue.posted.push({ id, engine, tag, body });
    const out = sandbox("ai-mode-task-post");
    out.cost = 0.0012;
    Object.assign(out.tasks[0], { id, cost: 0.0012 });
    return json(out);
  }
  if (action === "tasks_ready") {
    const out = sandbox("ai-mode-tasks-ready");
    const [template] = out.tasks[0].result;
    out.tasks[0].result = [...queue.posted, ...queue.foreign]
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

async function settledMicros(m: string): Promise<number> {
  const { rows } = await withSystem("capture.test", (tx) =>
    tx.execute<{ total: string }>(
      sql`select coalesce(sum(actual_amount_micros), 0)::text as total from ops.spend_ledger
          where ref_type = 'capture-test' and ref_id = ${m} and status = 'settled'`,
    ),
  );
  return Number(rows[0]?.total);
}

beforeEach(() => {
  switchedOff.clear();
  Object.assign(queue, { posted: [], foreign: [], fetched: [] });
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
    expect(queue.posted.map((t) => t.tag).sort()).toEqual([...ids].sort());
    expect(await ledger(m)).toEqual({ settled: 1550 });
    expect(await settledMicros(m)).toBe(1550 * 1200);
    // Queued already: posting again pays nothing.
    await expect(postCaptureTasks(m, ids, spend(m))).resolves.toEqual({ posted: 0, failed: [] });
    expect(queue.posted).toHaveLength(1550);
  }, 180_000);

  test("a slot whose task is already finished, or already stored, is not posted again", async () => {
    const { m, ids } = await frozen(cycle(3));
    // Posted by an earlier process: the provider lists it as finished.
    queue.foreign.push({
      id: randomUUID(),
      engine: "gemini",
      tag: ids[0] ?? "",
      body: new Uint8Array(),
    });
    await expect(postCaptureTasks(m, ids, spend(m))).resolves.toEqual({ posted: 2, failed: [] });
    expect(queue.posted.map((t) => t.tag).sort()).toEqual([ids[1], ids[2]].sort());
    await expect(collectReadyTasks(m)).resolves.toEqual({ collected: 3, pending: 0 });
    await expect(postCaptureTasks(m, ids, spend(m))).resolves.toEqual({ posted: 0, failed: [] });
    expect(queue.posted).toHaveLength(2);
  });

  test("a switched-off engine is neither listed nor posted", async () => {
    const { m, ids } = await frozen(cycle(3));
    switchedOff.add("capture-engine-gemini");
    const out = await postCaptureTasks(m, ids, spend(m));
    expect(out).toEqual({
      posted: 2,
      failed: [{ slotId: ids[0], code: "CaptureChannelDisabled" }],
    });
    expect(queue.posted.map((t) => t.engine).sort()).toEqual([
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
    expect(queue.fetched.sort()).toEqual(queue.posted.map((t) => t.id).sort());
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
    for (const task of queue.posted) {
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
        vendor_task_id: expect.any(String),
      });
    }
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
    // A second task for a stored slot (posted twice) is never fetched.
    queue.foreign.push({
      id: randomUUID(),
      engine: "gemini",
      tag: ids[0] ?? "",
      body: new Uint8Array(),
    });
    await expect(collectReadyTasks(m)).resolves.toEqual({ collected: 0, pending: 0 });
    expect(queue.fetched).toHaveLength(3);
    expect(await rowsOf(m)).toHaveLength(3);
  });
});
