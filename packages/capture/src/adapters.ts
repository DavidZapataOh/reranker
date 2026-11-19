import { InvalidInputError } from "@reranker/jobs/errors";
import type { CaptureChannel, CaptureProvider, ProviderCost } from "@reranker/schema";
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
}

export interface CaptureAdapter {
  provider: CaptureProvider;
  /** The channel recorded on the capture row: OpenAI is `api`, the UI vendors `ui-vendor`. */
  channel: CaptureChannel;
  /** Calls and parses only; capacity, spend and persistence belong to the caller. */
  captureLive(slot: FrozenSlot): Promise<CaptureRecord>;
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
