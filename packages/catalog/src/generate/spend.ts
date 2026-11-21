import {
  acquireProviderSlot,
  loadJobsConfig,
  ProviderUnavailableError,
  releaseSpend,
  reserveSpend,
  type SpendContext,
  type SpendReservation,
  settleSpend,
} from "@reranker/jobs";
import type { ProviderCost } from "@reranker/schema";
import { costOf, estimateOf, type GeneratorModel, type TokenUsage } from "./config";

export interface CallContext {
  spend: SpendContext;
  signal: AbortSignal;
  /** Epoch ms after which no call may still be waiting for a slot. */
  deadlineAt: number;
  /** Adds up what every call under this context settled, in USD micros. */
  spent?: { micros: number };
}

/** The provider answered and billed the call, but the answer cannot be used. */
export class BilledFailure extends Error {
  readonly usage: TokenUsage | undefined;

  constructor(reason: string, usage?: TokenUsage) {
    super(reason);
    this.name = "BilledFailure";
    this.usage = usage;
  }
}

async function settle(
  reservation: SpendReservation,
  actual: ProviderCost,
  ctx: CallContext,
): Promise<void> {
  await settleSpend(reservation, actual);
  if (ctx.spent) ctx.spent.micros += actual.amount_micros;
}

// An unusable answer was billed at its usage; an outage or an abort in flight may have been billed
// in full; a rejection before the model ran (rate limit, other 4xx) was not billed at all.
async function settleFailure(
  reservation: SpendReservation,
  model: GeneratorModel,
  error: unknown,
  ctx: CallContext,
): Promise<void> {
  if (error instanceof BilledFailure) {
    const actual = error.usage ? costOf(model, error.usage) : reservation.reserved;
    await settle(reservation, actual, ctx);
  } else if (error instanceof ProviderUnavailableError || ctx.signal.aborted) {
    await settle(reservation, reservation.reserved, ctx);
  } else {
    await releaseSpend(reservation);
  }
}

/**
 * One call under the provider's admission and the spend caps: slot, reservation, call, then
 * settle or release. Never retried: a retry cannot fit the generation deadline.
 *
 * Mirrors the billing contract of `paidCall` in @reranker/extraction, which cannot be imported
 * here because extraction depends on this package; moving both onto a shared LLM-call package
 * would remove the duplication.
 */
export async function paidCall<T>(
  provider: "openai" | "gemini",
  model: GeneratorModel,
  tokens: { input: number; output: number },
  ctx: CallContext,
  run: () => Promise<{ value: T; usage: TokenUsage }>,
): Promise<T> {
  ctx.signal.throwIfAborted();
  const slot = await acquireProviderSlot(provider, loadJobsConfig().limits[provider], {
    cost: { requests: 1, tokens: tokens.input + tokens.output },
    maxWaitMs: Math.max(0, ctx.deadlineAt - Date.now()),
  });
  try {
    ctx.signal.throwIfAborted();
    const reservation = await reserveSpend({
      provider,
      estimate: estimateOf(model, tokens.input, tokens.output),
      ...ctx.spend,
    });
    let outcome: { value: T; usage: TokenUsage };
    try {
      outcome = await run();
    } catch (error) {
      await settleFailure(reservation, model, error, ctx);
      throw error;
    }
    // The answer was billed: a settle that fails leaves the reservation standing, never released.
    await settle(reservation, costOf(model, outcome.usage), ctx);
    return outcome.value;
  } finally {
    await slot.release();
  }
}
