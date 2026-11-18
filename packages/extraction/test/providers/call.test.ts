import {
  ProviderRejectedError,
  ProviderUnavailableError,
  RateLimitedError,
  type SpendReservation,
} from "@reranker/jobs";
import { cost } from "@reranker/schema";
import { afterEach, expect, test, vi } from "vitest";
import { costOfUsage, estimateOf } from "../../src/prices";
import { callerFor, paidCall } from "../../src/providers/call";
import { callGemini } from "../../src/providers/gemini";
import { callOpenAI } from "../../src/providers/openai";
import {
  ProviderIncompleteError,
  ProviderRefusalError,
  type StructuredCall,
  type StructuredCaller,
  type StructuredResult,
} from "../../src/providers/types";
import { type MentionsOutput, MentionsSchema } from "../../src/schema";

const RESERVED = cost(9000, "USD");

const jobs = vi.hoisted(() => ({
  release: vi.fn(async () => {}),
  acquireProviderSlot: vi.fn(),
  reserveSpend: vi.fn(),
  settleSpend: vi.fn(async () => ({ applied: true })),
  releaseSpend: vi.fn(async () => ({ applied: true })),
  loadJobsConfig: vi.fn(() => ({
    limits: { openai: { maxInFlight: 8 }, gemini: { maxInFlight: 8 } },
  })),
}));

vi.mock("@reranker/jobs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@reranker/jobs")>()),
  ...jobs,
}));

jobs.acquireProviderSlot.mockImplementation(async () => ({ release: jobs.release }));
jobs.reserveSpend.mockImplementation(
  async (): Promise<SpendReservation> => ({
    id: "00000000-0000-4000-8000-000000000001",
    reserved: RESERVED,
    provider: "openai",
    purpose: "contract-test",
    scopes: [],
  }),
);

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

const spend = { purpose: "contract-test" as const, refType: "test", refId: "ref-1" };
const usage = {
  inputTokens: 1500,
  cachedInputTokens: 1000,
  cacheWriteTokens: 0,
  outputTokens: 300,
};
const call: Omit<StructuredCall<MentionsOutput>, "signal"> = {
  model: { provider: "openai", model: "gpt-6-luna", reasoning: "low" },
  system: "s".repeat(300),
  user: "u".repeat(600),
  schema: MentionsSchema,
  schemaName: "mentions",
  maxOutputTokens: 4096,
};

const ok = (): StructuredResult<MentionsOutput> => ({
  output: { answerKind: "no_entities", mentions: [] },
  modelReported: "gpt-6-luna-2026-10-01",
  usage,
  raw: {},
});

const callerOf = (impl: (c: StructuredCall<unknown>) => Promise<StructuredResult<unknown>>) =>
  vi.fn(impl) as unknown as StructuredCaller & ReturnType<typeof vi.fn>;

test("callerFor picks the adapter of the model's provider", () => {
  expect(callerFor({ provider: "openai", model: "gpt-6-luna", reasoning: "low" })).toBe(callOpenAI);
  expect(
    callerFor({ provider: "gemini", model: "gemini-3.1-flash-lite", reasoning: "minimal" }),
  ).toBe(callGemini);
});

test("reserves the estimate, settles the real cost and frees the slot", async () => {
  const caller = callerOf(async () => ok());
  const r = await paidCall(caller, call, { timeoutMs: 6000, retries: 1, spend });

  expect(jobs.acquireProviderSlot).toHaveBeenCalledWith(
    "openai",
    { maxInFlight: 8 },
    { cost: { requests: 1, tokens: 300 + 4096 } },
  );
  expect(jobs.reserveSpend).toHaveBeenCalledWith({
    provider: "openai",
    estimate: estimateOf("gpt-6-luna", 300, 4096),
    ...spend,
  });
  expect(jobs.settleSpend).toHaveBeenCalledWith(
    expect.objectContaining({ reserved: RESERVED }),
    costOfUsage("gpt-6-luna", usage),
  );
  expect(jobs.releaseSpend).not.toHaveBeenCalled();
  expect(jobs.release).toHaveBeenCalledTimes(1);
  expect(r.cost).toEqual(costOfUsage("gpt-6-luna", usage));
  expect(r.modelReported).toBe("gpt-6-luna-2026-10-01");
  expect(caller.mock.calls[0]?.[0].signal).toBeInstanceOf(AbortSignal);
});

test("a billed refusal settles its usage and is not retried", async () => {
  const refusal = new ProviderRefusalError("openai", "no", usage);
  const caller = callerOf(async () => {
    throw refusal;
  });
  await expect(paidCall(caller, call, { timeoutMs: 6000, retries: 1, spend })).rejects.toBe(
    refusal,
  );
  expect(caller).toHaveBeenCalledTimes(1);
  expect(jobs.settleSpend).toHaveBeenCalledWith(
    expect.anything(),
    costOfUsage("gpt-6-luna", usage),
  );
  expect(jobs.release).toHaveBeenCalledTimes(1);
});

test("a billed error without usage settles the reserved amount", async () => {
  const caller = callerOf(async () => {
    throw new ProviderIncompleteError("openai", "max_output_tokens");
  });
  await expect(
    paidCall(caller, call, { timeoutMs: 6000, retries: 0, spend }),
  ).rejects.toBeInstanceOf(ProviderIncompleteError);
  expect(jobs.settleSpend).toHaveBeenCalledWith(expect.anything(), RESERVED);
});

test.each([
  ["a rate limit", new RateLimitedError(1000, "OpenAI")],
  ["a rejection", new ProviderRejectedError("openai", "invalid_request")],
])("%s is released, not settled, and not retried", async (_, error) => {
  const caller = callerOf(async () => {
    throw error;
  });
  await expect(paidCall(caller, call, { timeoutMs: 6000, retries: 1, spend })).rejects.toBe(error);
  expect(caller).toHaveBeenCalledTimes(1);
  expect(jobs.releaseSpend).toHaveBeenCalledTimes(1);
  expect(jobs.settleSpend).not.toHaveBeenCalled();
  expect(jobs.release).toHaveBeenCalledTimes(1);
});

test("an outage settles the reservation, retries once after a backoff and adds both costs", async () => {
  vi.useFakeTimers();
  const caller = callerOf(async () => ok());
  caller.mockRejectedValueOnce(new ProviderUnavailableError("openai", 1000));
  const p = paidCall(caller, call, { timeoutMs: 6000, retries: 1, spend });
  await vi.advanceTimersByTimeAsync(299);
  expect(caller).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(301);
  const r = await p;
  expect(caller).toHaveBeenCalledTimes(2);
  expect(jobs.settleSpend).toHaveBeenNthCalledWith(1, expect.anything(), RESERVED);
  expect(r.cost.amount_micros).toBe(
    RESERVED.amount_micros + costOfUsage("gpt-6-luna", usage).amount_micros,
  );
  expect(jobs.release).toHaveBeenCalledTimes(2);
});

test("an outage on the last attempt reaches the caller", async () => {
  vi.useFakeTimers();
  const caller = callerOf(async () => {
    throw new ProviderUnavailableError("openai", 1000);
  });
  const p = paidCall(caller, call, { timeoutMs: 6000, retries: 1, spend });
  const settled = expect(p).rejects.toBeInstanceOf(ProviderUnavailableError);
  await vi.advanceTimersByTimeAsync(1000);
  await settled;
  expect(caller).toHaveBeenCalledTimes(2);
});

test("the deadline aborts the call, settles the reservation and rejects as unavailable", async () => {
  vi.useFakeTimers();
  let signal: AbortSignal | undefined;
  const caller = callerOf((c) => {
    signal = c.signal;
    return new Promise(() => {});
  });
  const p = paidCall(caller, call, { timeoutMs: 6000, retries: 0, spend });
  const settled = expect(p).rejects.toBeInstanceOf(ProviderUnavailableError);
  await vi.advanceTimersByTimeAsync(6000);
  await settled;
  expect(signal?.aborted).toBe(true);
  expect(jobs.settleSpend).toHaveBeenCalledWith(expect.anything(), RESERVED);
  expect(jobs.release).toHaveBeenCalledTimes(1);
});

test("a full spend cap frees the slot without calling the provider", async () => {
  const capped = new Error("cap");
  jobs.reserveSpend.mockRejectedValueOnce(capped);
  const caller = callerOf(async () => ok());
  await expect(paidCall(caller, call, { timeoutMs: 6000, retries: 1, spend })).rejects.toBe(capped);
  expect(caller).not.toHaveBeenCalled();
  expect(jobs.release).toHaveBeenCalledTimes(1);
});
