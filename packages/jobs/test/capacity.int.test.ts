import { endPools, withSystem } from "@reranker/db";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { predictedWaitMs, providerCapacity, registerCapacitySource } from "../src/capacity";
import { loadJobsConfig } from "../src/config";
import { guardModeStatus } from "../src/guard-mode";
import { acquireProviderSlot, type ProviderSlot } from "../src/leases";
import type { PaidProvider } from "../src/providers";

// A provider's default pool is shared by the whole database, so these tests use two providers
// that no other suite takes slots on.
const demand = {
  xai: { queuedSlots: 0, p50LatencyMs: 1000 },
  anthropic: { queuedSlots: 0, p50LatencyMs: 1000 },
};

beforeAll(() => {
  process.env.APP_ENV ??= "development";
  process.env.DB_POOL_MAX = "6";
  for (const provider of ["xai", "anthropic"] as const) {
    registerCapacitySource(provider, {
      queuedSlots: async () => demand[provider].queuedSlots,
      p50LatencyMs: async () => demand[provider].p50LatencyMs,
    });
  }
});
afterAll(() => endPools());

const held: ProviderSlot[] = [];
afterEach(async () => {
  await Promise.all(held.splice(0).map((slot) => slot.release()));
  await withSystem("test.capacity", async (tx) => {
    await tx.execute(
      sql`delete from ops.concurrency_leases where key in ('xai:default', 'anthropic:default')`,
    );
    await tx.execute(
      sql`delete from ops.guard_modes where name in ('jobs-saturated:xai', 'jobs-saturated:anthropic')`,
    );
  });
});

const limitOf = (provider: PaidProvider) => loadJobsConfig().limits[provider].maxInFlight;

async function holdLeases(provider: PaidProvider, count: number) {
  const limits = { maxInFlight: limitOf(provider) };
  for (let i = 0; i < count; i++) held.push(await acquireProviderSlot(provider, limits));
}

describe("providerCapacity", () => {
  test("reads the live leases, the limit and the registered source", async () => {
    demand.xai = { queuedSlots: 50, p50LatencyMs: 18_000 };
    const limit = limitOf("xai");
    await holdLeases("xai", limit);
    const expected = predictedWaitMs({
      queuedSlots: 50,
      inFlight: limit,
      limit,
      p50LatencyMs: 18_000,
    });
    expect(expected).toBeGreaterThan(0);
    expect(await providerCapacity("xai")).toEqual({
      inFlight: limit,
      limit,
      queuedSlots: 50,
      p50LatencyMs: 18_000,
      predictedWaitMs: expected,
    });
  });

  test("a lease that expired or was released no longer counts", async () => {
    demand.anthropic = { queuedSlots: 0, p50LatencyMs: 1000 };
    await holdLeases("anthropic", 2);
    await withSystem("test.capacity", (tx) =>
      tx.execute(sql`insert into ops.concurrency_leases (key, expires_at)
        values ('anthropic:default', clock_timestamp() - interval '1 second')`),
    );
    expect((await providerCapacity("anthropic")).inFlight).toBe(2);
    await held.pop()?.release();
    expect((await providerCapacity("anthropic")).inFlight).toBe(1);
  });

  test("a wait beyond a minute trips the saturation guard mode that names the provider", async () => {
    demand.xai = { queuedSlots: 500, p50LatencyMs: 30_000 };
    expect(await guardModeStatus("jobs-saturated:xai")).toMatchObject({ active: false });
    const capacity = await providerCapacity("xai");
    expect(capacity.predictedWaitMs).toBeGreaterThan(60_000);
    expect(await guardModeStatus("jobs-saturated:xai")).toMatchObject({ active: true });
  });

  test("a short wait leaves the guard mode alone", async () => {
    demand.anthropic = { queuedSlots: 0, p50LatencyMs: 1000 };
    await providerCapacity("anthropic");
    expect(await guardModeStatus("jobs-saturated:anthropic")).toMatchObject({ active: false });
  });
});
