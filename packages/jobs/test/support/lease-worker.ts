import { endPools } from "@reranker/db";
import { acquireProviderSlot } from "../../src/leases";

// One process of the fleet. The parent starts it with a JSON job in argv and reads what it sends.
export interface WorkerJob {
  account: string;
  maxInFlight: number;
  // Parallel acquirers inside this process, never above its pool size.
  lanes: number;
  acquisitions: number;
  holdMs: number;
  // Takes one slot, reports it and never lets go, so the parent can kill the holder.
  hold?: boolean;
}

export interface WorkerResult {
  waitedMs: number;
  error?: { name: string; retryAfterMs?: number };
}

const job = JSON.parse(process.argv[2] ?? "{}") as WorkerJob;
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const limits = { maxInFlight: job.maxInFlight, account: job.account };

async function once(): Promise<WorkerResult> {
  const startedAt = Date.now();
  try {
    const slot = await acquireProviderSlot("dataforseo", limits);
    await delay(job.holdMs);
    await slot.release();
    return { waitedMs: Date.now() - startedAt };
  } catch (error) {
    const e = error as { name: string; retryAfterMs?: number };
    return {
      waitedMs: Date.now() - startedAt,
      error: {
        name: e.name,
        ...(e.retryAfterMs === undefined ? {} : { retryAfterMs: e.retryAfterMs }),
      },
    };
  }
}

async function lane(count: number): Promise<WorkerResult[]> {
  const results: WorkerResult[] = [];
  for (let i = 0; i < count; i++) results.push(await once());
  return results;
}

// The parent starts every process together once all of them are loaded.
const started = new Promise<void>((resolve) => process.once("message", () => resolve()));

if (job.hold) {
  await acquireProviderSlot("dataforseo", limits, { maxWaitMs: 0 });
  process.send?.({ held: true });
  await new Promise(() => undefined);
} else {
  process.send?.({ ready: true });
  await started;
  const perLane = Math.ceil(job.acquisitions / job.lanes);
  const results = (
    await Promise.all(Array.from({ length: job.lanes }, () => lane(perLane)))
  ).flat();
  await endPools();
  process.send?.({ results });
}
