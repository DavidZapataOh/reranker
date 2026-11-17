import { beforeEach, describe, expect, test, vi } from "vitest";

const execute = vi.fn();
const withSystem = vi.fn(async (_reason: string, fn: (tx: unknown) => unknown) => fn({ execute }));
vi.mock("@reranker/db", () => ({ withSystem }));
const startOnce = vi.fn(
  async (_kind: string, _key: string, start: () => Promise<{ runId: string }>) => ({
    runId: (await start()).runId,
    created: true,
  }),
);
vi.mock("../src/start-once", () => ({ startOnce }));

const { InvalidInputError, JobAttemptsExhaustedError, NotFoundError } = await import(
  "../src/errors"
);
const { defineJob, enqueue, registerJobStarter, registerOpportunistic, runJob, runOpportunistic } =
  await import("../src/jobs");

const starter = vi.fn(async () => ({ runId: "wrun_1" }));
const handler = vi.fn(async (_payload: unknown, _ctx: unknown) => undefined);
const job = defineJob<{ id: string }>({ name: "unit.job", handler });
defineJob<{ id: string }>({ name: "unit.limited", handler, maxAttempts: 2 });

beforeEach(() => {
  execute.mockReset();
  withSystem.mockClear();
  startOnce.mockClear();
  starter.mockClear();
  handler.mockReset();
  registerJobStarter(starter);
});

describe("defineJob", () => {
  test("returns the definition and accepts the same one again", () => {
    const def = { name: "unit.same", handler };
    expect(defineJob(def)).toBe(def);
    expect(defineJob(def)).toBe(def);
  });

  test("a different job under a taken name is rejected", () =>
    expect(() => defineJob({ name: "unit.job", handler })).toThrow(InvalidInputError));

  test.each([
    [{ name: "" }],
    [{ name: "has:colon" }],
    [{ name: "has space" }],
    [{ name: "x".repeat(65) }],
    [{ name: "unit.attempts", maxAttempts: 0 }],
    [{ name: "unit.attempts", maxAttempts: 11 }],
    [{ name: "unit.attempts", maxAttempts: 1.5 }],
    [{ name: "unit.timeout", timeoutMs: 0 }],
    [{ name: "unit.timeout", timeoutMs: 140_001 }],
  ])("rejects %j", (fields) =>
    expect(() => defineJob({ handler, ...fields })).toThrow(InvalidInputError),
  );
});

describe("enqueue", () => {
  test("starts once per job and dedupe key with the run arguments", async () => {
    const runAt = new Date("2026-11-17T15:00:00Z");
    await expect(
      enqueue(job, { id: "r1" }, { dedupeKey: "report-1", runAt, priority: "normal" }),
    ).resolves.toEqual({ jobId: "unit.job:report-1", created: true });
    expect(startOnce.mock.calls[0]?.slice(0, 2)).toEqual(["job", "unit.job:report-1"]);
    expect(starter).toHaveBeenCalledWith({
      name: "unit.job",
      payload: { id: "r1" },
      runAt: "2026-11-17T15:00:00.000Z",
      jobId: "unit.job:report-1",
    });
  });

  test("a job without payload starts with none", async () => {
    const none = defineJob<void>({ name: "unit.none", handler });
    await enqueue(none, undefined, { dedupeKey: "k" });
    expect(starter).toHaveBeenCalledWith(expect.objectContaining({ payload: undefined }));
  });

  test("reports a run another caller started", async () => {
    startOnce.mockResolvedValueOnce({ runId: "wrun_0", created: false });
    await expect(enqueue(job, { id: "r1" }, { dedupeKey: "k" })).resolves.toEqual({
      jobId: "unit.job:k",
      created: false,
    });
  });

  test("a job that was never defined is rejected", async () => {
    await expect(enqueue({ ...job }, { id: "r1" }, { dedupeKey: "k" })).rejects.toBeInstanceOf(
      InvalidInputError,
    );
    await expect(
      enqueue({ name: "unit.unknown", handler }, { id: "r1" }, { dedupeKey: "k" }),
    ).rejects.toBeInstanceOf(InvalidInputError);
    expect(startOnce).not.toHaveBeenCalled();
  });

  class Point {
    x = 1;
  }
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  test.each([
    ["a function", { f: () => 1 }],
    ["a symbol", { s: Symbol("x") }],
    ["a bigint", { n: 1n }],
    ["a non-finite number", { n: Number.NaN }],
    ["a map", { m: new Map() }],
    ["a class instance", { p: new Point() }],
    ["a cycle", cyclic],
    ["64 KB or more", { blob: "x".repeat(64 * 1024) }],
  ])("a payload with %s is rejected", async (_label, payload) => {
    await expect(
      enqueue(job, payload as unknown as { id: string }, { dedupeKey: "k" }),
    ).rejects.toBeInstanceOf(InvalidInputError);
    expect(startOnce).not.toHaveBeenCalled();
  });

  test("plain data with dates, nulls and nested arrays is accepted", async () => {
    const payload = { id: "r1", at: new Date(0), tags: [["a"], null], meta: Object.create(null) };
    await enqueue(job, payload, { dedupeKey: "k" });
    expect(starter).toHaveBeenCalledWith(expect.objectContaining({ payload }));
  });

  test.each([
    ["an empty dedupe key", { dedupeKey: "" }],
    ["a dedupe key with an address", { dedupeKey: "10.0.0.1" }],
    ["a dedupe key with an email", { dedupeKey: "ana@example.com" }],
    ["an invalid runAt", { dedupeKey: "k", runAt: new Date(Number.NaN) }],
    ["an unknown priority", { dedupeKey: "k", priority: "urgent" }],
  ])("%s is rejected", async (_label, opts) => {
    await expect(
      enqueue(job, { id: "r1" }, opts as Parameters<typeof enqueue>[2]),
    ).rejects.toBeInstanceOf(InvalidInputError);
    expect(startOnce).not.toHaveBeenCalled();
  });

  test("fails loudly when no starter is registered", async () => {
    const key = Symbol.for("@reranker/jobs/starter");
    const saved = Reflect.get(globalThis, key);
    Reflect.deleteProperty(globalThis, key);
    try {
      await expect(enqueue(job, { id: "r1" }, { dedupeKey: "k" })).rejects.toThrow(
        "No job starter",
      );
    } finally {
      Reflect.set(globalThis, key, saved);
    }
  });
});

describe("runJob", () => {
  test("runs the handler with the attempt and the job id", async () => {
    await runJob("unit.job", { id: "r1" }, 2, "unit.job:k");
    expect(handler).toHaveBeenCalledWith(
      { id: "r1" },
      expect.objectContaining({ attempt: 2, jobId: "unit.job:k", signal: expect.any(AbortSignal) }),
    );
  });

  test("an unknown job is not found", () =>
    expect(runJob("unit.unknown", {}, 1, "unit.unknown:k")).rejects.toBeInstanceOf(NotFoundError));

  test("a failure before the last attempt is rethrown as is so the step retries", async () => {
    const failure = new Error("flaky");
    handler.mockRejectedValue(failure);
    await expect(runJob("unit.job", {}, 3, "j")).rejects.toBe(failure);
  });

  test("a failure on the last attempt ends the job and keeps the cause", async () => {
    const failure = new Error("still failing");
    handler.mockRejectedValue(failure);
    const error = await runJob("unit.job", {}, 4, "j").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(JobAttemptsExhaustedError);
    expect(error).toMatchObject({ name: "JobAttemptsExhausted", cause: failure });
    expect((error as Error).message).toContain("Error: still failing");
    await expect(runJob("unit.limited", {}, 2, "j")).rejects.toBeInstanceOf(
      JobAttemptsExhaustedError,
    );
  });

  test("a thrown non-error still ends the job on the last attempt", async () => {
    handler.mockRejectedValue("text");
    await expect(runJob("unit.limited", {}, 2, "j")).rejects.toBeInstanceOf(
      JobAttemptsExhaustedError,
    );
  });

  test("an attempt past the limit never runs the handler", async () => {
    await expect(runJob("unit.limited", {}, 3, "j")).rejects.toBeInstanceOf(
      JobAttemptsExhaustedError,
    );
    expect(handler).not.toHaveBeenCalled();
  });

  test("a handler that outlives its timeout fails and sees its signal abort", async () => {
    let signal: AbortSignal | undefined;
    const slow = defineJob<void>({
      name: "unit.slow",
      timeoutMs: 20,
      handler: (_payload, ctx) => {
        signal = ctx.signal;
        return new Promise(() => undefined);
      },
    });
    await expect(runJob(slow.name, undefined, 1, "j")).rejects.toMatchObject({
      name: "TimeoutError",
    });
    expect(signal?.aborted).toBe(true);
  });
});

describe("opportunistic work", () => {
  const ots = defineJob<void>({ name: "unit.ots", handler });

  test("rejects a job that was never defined, a bad name or a bad interval", () => {
    expect(() =>
      registerOpportunistic("a", { name: "unit.ghost", handler }, { minIntervalMs: 1000 }),
    ).toThrow(InvalidInputError);
    expect(() => registerOpportunistic("bad name", ots, { minIntervalMs: 1000 })).toThrow(
      InvalidInputError,
    );
    for (const minIntervalMs of [0, 1.5, 2 ** 31]) {
      expect(() => registerOpportunistic("a", ots, { minIntervalMs })).toThrow(InvalidInputError);
    }
  });

  test("with nothing registered it touches no database", async () => {
    await expect(runOpportunistic()).resolves.toEqual([]);
    expect(withSystem).not.toHaveBeenCalled();
  });

  test("claims every entry in one statement and enqueues the ones it won", async () => {
    registerOpportunistic("otsUpgrade", ots, { minIntervalMs: 60_000 });
    registerOpportunistic("cleanup", ots, { minIntervalMs: 3_600_000 });
    const at = new Date("2026-11-16T12:00:00Z");
    execute.mockResolvedValue({ rows: [{ name: "otsUpgrade", last_run_at: at.toISOString() }] });
    await expect(runOpportunistic()).resolves.toEqual(["otsUpgrade"]);
    expect(withSystem.mock.calls[0]?.[0]).toBe("jobs.opportunistic");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(starter).toHaveBeenCalledTimes(1);
    expect(starter).toHaveBeenCalledWith({
      name: "unit.ots",
      payload: undefined,
      runAt: null,
      jobId: `unit.ots:otsUpgrade-${at.getTime()}`,
    });
  });
});
