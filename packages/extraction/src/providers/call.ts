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
import { addCost, cost, type ProviderCost } from "@reranker/schema";
import { costOfUsage, estimateOf } from "../prices";
import { callAnthropic } from "./anthropic";
import { callGemini } from "./gemini";
import { callOpenAI } from "./openai";
import {
  type ModelRef,
  ProviderIncompleteError,
  ProviderRefusalError,
  type StructuredCall,
  type StructuredCaller,
  type StructuredResult,
} from "./types";

export interface PaidCallOptions {
  /** Deadline of each attempt. */
  timeoutMs: number;
  /** Extra attempts after a `ProviderUnavailableError` (outage, lost connection or deadline). */
  retries: 0 | 1;
  spend: SpendContext;
}

export type PaidResult<T> = StructuredResult<T> & {
  /** Every attempt's settled cost, the failed ones included. */
  cost: ProviderCost;
  latencyMs: number;
};

const CALLERS: Record<ModelRef["provider"], StructuredCaller> = {
  openai: callOpenAI,
  gemini: callGemini,
  anthropic: callAnthropic,
};

export function callerFor(model: ModelRef): StructuredCaller {
  return CALLERS[model.provider];
}

// Spanish text averages over three characters per token on these tokenizers; three keeps the
// reservation and the token bucket above what the call will use.
const CHARS_PER_TOKEN = 3;
const RETRY_BACKOFF_MS = { min: 300, jitter: 300 };
const DEADLINE_RETRY_AFTER_MS = 1000;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function estimatedInputTokens(call: Omit<StructuredCall<unknown>, "signal">): number {
  return Math.ceil((call.system.length + call.user.length) / CHARS_PER_TOKEN);
}

/** Cuts the call at the deadline even when the caller ignores the abort signal. */
function withDeadline<T>(
  caller: StructuredCaller,
  call: Omit<StructuredCall<T>, "signal">,
  timeoutMs: number,
): Promise<StructuredResult<T>> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new ProviderUnavailableError(call.model.provider, DEADLINE_RETRY_AFTER_MS));
    }, timeoutMs);
  });
  return Promise.race([caller({ ...call, signal: controller.signal }), deadline]).finally(() =>
    clearTimeout(timer),
  );
}

/**
 * Settles what a failed call may have cost. An answer that came back was billed at its usage;
 * an outage, a lost connection or the deadline may have been billed in full; a rejection before
 * the model ran (rate limit, other 4xx) was not billed at all.
 */
async function settleFailure(
  reservation: SpendReservation,
  model: string,
  error: unknown,
): Promise<ProviderCost> {
  if (error instanceof ProviderRefusalError || error instanceof ProviderIncompleteError) {
    const actual = error.usage ? costOfUsage(model, error.usage) : reservation.reserved;
    await settleSpend(reservation, actual);
    return actual;
  }
  if (error instanceof ProviderUnavailableError) {
    await settleSpend(reservation, reservation.reserved);
    return reservation.reserved;
  }
  await releaseSpend(reservation);
  return cost(0, reservation.reserved.currency);
}

async function attempt<T>(
  caller: StructuredCaller,
  call: Omit<StructuredCall<T>, "signal">,
  opts: PaidCallOptions,
): Promise<{ result: StructuredResult<T> | null; error: unknown; cost: ProviderCost }> {
  const { provider, model } = call.model;
  const inputTokens = estimatedInputTokens(call);
  const slot = await acquireProviderSlot(provider, loadJobsConfig().limits[provider], {
    cost: { requests: 1, tokens: inputTokens + call.maxOutputTokens },
  });
  try {
    const reservation = await reserveSpend({
      provider,
      estimate: estimateOf(model, inputTokens, call.maxOutputTokens),
      ...opts.spend,
    });
    try {
      const result = await withDeadline(caller, call, opts.timeoutMs);
      const actual = costOfUsage(model, result.usage);
      await settleSpend(reservation, actual);
      return { result, error: null, cost: actual };
    } catch (error) {
      return { result: null, error, cost: await settleFailure(reservation, model, error) };
    }
  } finally {
    await slot.release();
  }
}

/**
 * One structured call under the provider's admission and the spend caps: slot, reservation,
 * call with a deadline, then settle or release. Only an unavailable provider is retried here;
 * every other error goes to the workflow step unchanged.
 */
export async function paidCall<T>(
  caller: StructuredCaller,
  call: Omit<StructuredCall<T>, "signal">,
  opts: PaidCallOptions,
): Promise<PaidResult<T>> {
  const startedAt = Date.now();
  let spent: ProviderCost | null = null;
  for (let tried = 0; ; tried++) {
    const outcome = await attempt(caller, call, opts);
    spent = spent ? addCost(spent, outcome.cost) : outcome.cost;
    if (outcome.result) {
      return { ...outcome.result, cost: spent, latencyMs: Date.now() - startedAt };
    }
    if (!(outcome.error instanceof ProviderUnavailableError) || tried >= opts.retries) {
      throw outcome.error;
    }
    await sleep(RETRY_BACKOFF_MS.min + Math.random() * RETRY_BACKOFF_MS.jitter);
  }
}
