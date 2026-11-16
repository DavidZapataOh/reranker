import { randomUUID } from "node:crypto";
import { endPools, withSystem } from "@reranker/db";
import { workflowStarts } from "@reranker/db/schema";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, test, vi } from "vitest";
import { startOnce } from "../src/start-once";

// Concurrency is real only with more connections than the default three of the system pool.
process.env.DB_POOL_MAX = "20";
afterAll(() => endPools());

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const unique = () => `test-${randomUUID()}`;
const claim = (kind: string, key: string) =>
  and(eq(workflowStarts.kind, kind), eq(workflowStarts.key, key));

const statusOf = async (kind: string, key: string) => {
  const [row] = await withSystem("test.start-once", (tx) =>
    tx.select({ status: workflowStarts.status }).from(workflowStarts).where(claim(kind, key)),
  );
  return row?.status;
};

const expireClaim = (kind: string, key: string) =>
  withSystem("test.start-once", (tx) =>
    tx
      .update(workflowStarts)
      .set({ createdAt: sql`created_at - interval '31 seconds'` })
      .where(claim(kind, key)),
  );

const failingStart = async (): Promise<{ runId: string }> => {
  throw new Error("down");
};

describe("startOnce", () => {
  test("20 concurrent calls start exactly once and share the run id", async () => {
    const key = unique();
    const start = vi.fn(async () => {
      await delay(200);
      return { runId: "wrun_A" };
    });
    const out = await Promise.all(Array.from({ length: 20 }, () => startOnce("t", key, start)));
    expect(start).toHaveBeenCalledTimes(1);
    expect(new Set(out.map((o) => o.runId))).toEqual(new Set(["wrun_A"]));
    expect(out.filter((o) => o.created)).toHaveLength(1);
    expect(await statusOf("t", key)).toBe("started");
  });

  test("a later call returns the recorded run without starting again", async () => {
    const key = unique();
    await startOnce("t", key, async () => ({ runId: "wrun_C" }));
    const start = vi.fn(async () => ({ runId: "wrun_X" }));
    await expect(startOnce("t", key, start)).resolves.toEqual({ runId: "wrun_C", created: false });
    expect(start).not.toHaveBeenCalled();
  });

  test("a failed start stays pending and the next attempt retries it", async () => {
    const key = unique();
    await expect(startOnce("t", key, failingStart)).rejects.toThrow("down");
    expect(await statusOf("t", key)).toBe("pending");
    await expireClaim("t", key);
    await expect(startOnce("t", key, async () => ({ runId: "wrun_B" }))).resolves.toEqual({
      runId: "wrun_B",
      created: true,
    });
    expect(await statusOf("t", key)).toBe("started");
  });

  test("a recent pending claim yields a null run id after the wait", async () => {
    const key = unique();
    await expect(startOnce("t", key, failingStart)).rejects.toThrow();
    const start = vi.fn(async () => ({ runId: "wrun_Z" }));
    await expect(startOnce("t", key, start)).resolves.toEqual({ runId: null, created: false });
    expect(start).not.toHaveBeenCalled();
  }, 15_000);

  test("concurrent takeovers of a stale claim start once", async () => {
    const key = unique();
    await expect(startOnce("t", key, failingStart)).rejects.toThrow();
    await expireClaim("t", key);
    const start = vi.fn(async () => {
      await delay(100);
      return { runId: "wrun_D" };
    });
    const out = await Promise.all(Array.from({ length: 10 }, () => startOnce("t", key, start)));
    expect(start).toHaveBeenCalledTimes(1);
    expect(new Set(out.map((o) => o.runId))).toEqual(new Set(["wrun_D"]));
  });

  test("different kinds with the same key are independent", async () => {
    const key = unique();
    const a = await startOnce("a", key, async () => ({ runId: "wrun_1" }));
    const b = await startOnce("b", key, async () => ({ runId: "wrun_2" }));
    expect([a.runId, b.runId]).toEqual(["wrun_1", "wrun_2"]);
  });
});
