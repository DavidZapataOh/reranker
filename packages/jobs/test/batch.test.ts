import { describe, expect, test } from "vitest";
import { runBatch } from "../src/batch";
import { RateLimitedError } from "../src/errors";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const range = (n: number) => Array.from({ length: n }, (_, i) => i);

describe("runBatch", () => {
  test("skips done keys and limits concurrency", async () => {
    let live = 0;
    let peak = 0;
    const called: number[] = [];
    const res = await runBatch(
      range(12),
      async (i) => {
        called.push(i);
        live++;
        peak = Math.max(peak, live);
        await delay(10);
        live--;
        return i * 2;
      },
      { key: String, isDone: async (k) => (k === "3" ? 6 : null), concurrency: 4 },
    );
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1);
    expect(res.find((r) => r.key === "3")).toEqual({ key: "3", ok: true, value: 6 });
    expect(called).not.toContain(3);
    expect(res).toHaveLength(12);
    expect(res.map((r) => r.key)).toEqual(range(12).map(String));
  });

  test("collects per-item errors without throwing", async () => {
    const res = await runBatch(
      [1, 2],
      async (i) => {
        if (i === 2) throw new RateLimitedError(1000);
        return i;
      },
      { key: String, isDone: async () => null, concurrency: 2 },
    );
    expect(res[0]).toEqual({ key: "1", ok: true, value: 1 });
    expect(res[1]).toMatchObject({ key: "2", ok: false, error: expect.any(RateLimitedError) });
  });

  test("wraps non-Error throws and failing isDone lookups as errors", async () => {
    const res = await runBatch(
      ["a", "b"],
      async () => {
        throw "boom";
      },
      {
        key: String,
        isDone: async (k) => {
          if (k === "b") throw new Error("lookup failed");
          return null;
        },
        concurrency: 1,
      },
    );
    expect(res[0]).toMatchObject({ ok: false, error: new Error("boom") });
    expect(res[1]).toMatchObject({ ok: false, error: new Error("lookup failed") });
  });

  test("returns an empty result for no items and rejects invalid concurrency", async () => {
    const opts = { key: String, isDone: async () => null };
    await expect(runBatch([], async () => 1, { ...opts, concurrency: 3 })).resolves.toEqual([]);
    await expect(runBatch([1], async () => 1, { ...opts, concurrency: 0 })).rejects.toThrow(
      RangeError,
    );
  });
});
