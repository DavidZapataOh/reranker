import { ENGINES } from "./engines";
import type { FrozenSlot } from "./slot";

/**
 * Slowest engine first, so the long calls overlap the short ones instead of trailing them; within
 * an engine the intents take turns, so a deadline that cuts the tail leaves every intent measured.
 */
export function dispatchOrder(slots: readonly FrozenSlot[]): FrozenSlot[] {
  const byEngine = Map.groupBy(slots, (slot) => slot.engine);
  const engines = [...byEngine.keys()].sort(
    (a, b) => ENGINES[b].p50LatencyMs - ENGINES[a].p50LatencyMs,
  );
  return engines.flatMap((engine) => {
    const queues = [...Map.groupBy(byEngine.get(engine) ?? [], (s) => s.intentId).values()];
    const longest = Math.max(...queues.map((q) => q.length));
    return Array.from({ length: longest }, (_, turn) =>
      queues.flatMap((queue) => queue.slice(turn, turn + 1)),
    ).flat();
  });
}

/**
 * One more call fits only when the provider's advertised wait and the engine's usual latency both
 * end before the deadline; without a deadline there is always time.
 */
export function retryFits(input: {
  slot: FrozenSlot;
  retryAfterMs: number;
  deadlineAt: number | undefined;
  now: number;
}): boolean {
  if (input.deadlineAt === undefined) return true;
  const needed = input.retryAfterMs + ENGINES[input.slot.engine].p50LatencyMs;
  return input.deadlineAt - input.now > needed;
}
