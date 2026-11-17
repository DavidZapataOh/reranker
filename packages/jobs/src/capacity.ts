import { withSystem } from "@reranker/db";
import { sql } from "drizzle-orm";
import { loadJobsConfig } from "./config";
import { InvalidInputError } from "./errors";
import { tripGuardMode } from "./guard-mode";
import { leasePoolKey } from "./leases";
import type { PaidProvider } from "./providers";
import { createRegistry } from "./registry";
import { providerSaturated } from "./telemetry";

/** What only the capture side knows: planned slots not started yet and how long a call takes. */
export interface CapacitySource {
  queuedSlots(): Promise<number>;
  p50LatencyMs(): Promise<number>;
}

export interface ProviderCapacity {
  inFlight: number;
  limit: number;
  queuedSlots: number;
  p50LatencyMs: number;
  predictedWaitMs: number;
}

// Past this wait the free report cannot promise its time, so the alert of the saturation mode fires.
const SATURATED_WAIT_MS = 60_000;

const sources = createRegistry<CapacitySource>("capacity source");

export function registerCapacitySource(provider: PaidProvider, source: CapacitySource): void {
  sources.register(provider, source);
}

/** The demand beyond the limit takes whole rounds of the median call to drain. */
export function predictedWaitMs(input: {
  queuedSlots: number;
  inFlight: number;
  limit: number;
  p50LatencyMs: number;
}): number {
  const { queuedSlots, inFlight, limit, p50LatencyMs } = input;
  if (!(limit > 0)) throw new InvalidInputError("A provider limit must be positive");
  return Math.round((Math.max(0, queuedSlots + inFlight - limit) / limit) * p50LatencyMs);
}

function measure(name: string, value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new InvalidInputError(`Capacity source returned an invalid ${name}`);
  }
  return value;
}

async function liveLeases(provider: PaidProvider): Promise<number> {
  const { rows } = await withSystem("jobs.capacity", (tx) =>
    tx.execute<{ in_flight: number }>(
      sql`select count(*)::int as in_flight from ops.concurrency_leases
           where key = ${leasePoolKey(provider)} and expires_at > clock_timestamp()`,
    ),
  );
  return rows[0]?.in_flight ?? 0;
}

/** Live demand on a provider's default account, for admission to decide to start, warn or defer. */
export async function providerCapacity(provider: PaidProvider): Promise<ProviderCapacity> {
  const source = sources.get(provider);
  if (!source) throw new InvalidInputError(`No capacity source is registered for ${provider}`);
  const limit = loadJobsConfig().limits[provider].maxInFlight;
  const [inFlight, queuedSlots, p50LatencyMs] = await Promise.all([
    liveLeases(provider),
    source.queuedSlots().then((n) => measure("queuedSlots", n)),
    source.p50LatencyMs().then((n) => measure("p50LatencyMs", n)),
  ]);
  const wait = predictedWaitMs({ queuedSlots, inFlight, limit, p50LatencyMs });
  if (wait > SATURATED_WAIT_MS) {
    // A failed alert must not hide the reading that admission is waiting for.
    await tripGuardMode(`jobs-saturated:${provider}`, "predicted wait", SATURATED_WAIT_MS).catch(
      (error: unknown) => {
        console.error("[jobs] saturation guard mode failed", {
          code: (error as { code?: unknown }).code,
        });
      },
    );
    await providerSaturated(provider, wait);
  }
  return { inFlight, limit, queuedSlots, p50LatencyMs, predictedWaitMs: wait };
}
