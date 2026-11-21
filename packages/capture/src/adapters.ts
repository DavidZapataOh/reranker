import { InvalidInputError } from "@reranker/jobs/errors";
import type { CaptureChannel, CaptureProvider, EngineId, ProviderCost } from "@reranker/schema";
import type { CaptureId } from "@reranker/verify/format";
import type { EngineAnswer } from "./answer";
import type { FrozenSlot } from "./slot";

/** One provider call with the exact bytes on the wire, ready to seal and persist. */
export interface CaptureRecord {
  slot: FrozenSlot;
  captureId: CaptureId;
  status: "succeeded" | "provider_error" | "timeout";
  providerStatusCode: number | null;
  httpStatus: number | null;
  request: Uint8Array;
  response: Uint8Array;
  responseContentType: string;
  /** The URL called, as the signed statement names it. */
  endpoint: string;
  /** The provider's id for the task, when it reports one. */
  providerTaskId: string | null;
  answer: EngineAnswer | null;
  parseError: string | null;
  modelReported: string | null;
  cost: ProviderCost | null;
  latencyMs: number;
  mode: "live" | "task";
  /** The adapter's reading of a failed call; without it the DataForSEO status decides. */
  failure?: { error: Error; retryable: boolean };
}

/** A queued task as the provider answered its posting. */
export interface PostedTask {
  /** The provider's id for the task, when it accepted it. */
  providerTaskId: string | null;
  cost: ProviderCost | null;
  /** Why the provider refused the task, or null when it was accepted. */
  error: Error | null;
}

/** A finished task of a measurement, waiting to be fetched. */
export interface ReadyTask {
  slot: FrozenSlot;
  providerTaskId: string;
  /** Fetches the result: one provider call, its bytes ready to seal. */
  collect(): Promise<CaptureRecord | null>;
}

export interface CaptureAdapter {
  provider: CaptureProvider;
  /** The channel recorded on the capture row: OpenAI is `api`, the UI vendors `ui-vendor`. */
  channel: CaptureChannel;
  /** What a call reserves before it runs, when the engine's UI-vendor estimate does not apply. */
  estimate?(slot: FrozenSlot): ProviderCost;
  /** Calls and parses only; capacity, spend and persistence belong to the caller. */
  captureLive(slot: FrozenSlot): Promise<CaptureRecord>;
  /** The current parser of an engine's responses, which re-derives answers from sealed bytes. */
  parse?(engine: EngineId, bytes: Uint8Array): EngineAnswer;
  /** Queues one slot on the provider's cheaper, slower queue; throws only when nothing came back. */
  postTask?(slot: FrozenSlot): Promise<PostedTask>;
  /** Finished tasks of `slots`; tasks of anything else on the account stay untouched. */
  collectReady?(slots: readonly FrozenSlot[]): Promise<ReadyTask[]>;
  /** Fetches a task's result by id; null while the provider has not finished it. */
  collectTask?(slot: FrozenSlot, providerTaskId: string): Promise<CaptureRecord | null>;
  /**
   * Tasks of `slots` the provider created within `window`, finished or not, found by their tag:
   * how a posting whose answer never arrived is settled without posting again.
   */
  findTasks?(slots: readonly FrozenSlot[], window: { from: Date; to: Date }): Promise<FoundTask[]>;
}

/** A task the provider holds for a slot. */
export interface FoundTask {
  slot: FrozenSlot;
  providerTaskId: string;
  cost: ProviderCost | null;
}

const adapters = new Map<CaptureProvider, CaptureAdapter>();

export function registerCaptureAdapter(adapter: CaptureAdapter): void {
  const current = adapters.get(adapter.provider);
  if (current !== undefined && current !== adapter) {
    throw new InvalidInputError(`A capture adapter for ${adapter.provider} is already registered`);
  }
  adapters.set(adapter.provider, adapter);
}

export function adapterFor(provider: CaptureProvider): CaptureAdapter {
  const adapter = adapters.get(provider);
  if (adapter === undefined) {
    throw new InvalidInputError(`No capture adapter is registered for ${provider}`);
  }
  return adapter;
}
