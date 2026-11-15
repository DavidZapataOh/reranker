import type { CaptureChannel, CaptureProvider, EngineId } from "@reranker/schema";
import { definitionsEtag, warmUp } from "./client";
import { CaptureChannelDisabledError, FlagsNotReadyError } from "./errors";
import { evaluate, on } from "./evaluate";
import { type FlagKey, KILL_SWITCH_KEYS, type KillSwitchKey } from "./flag-keys.gen";

export type CaptureInput = {
  channel: CaptureChannel;
  provider: CaptureProvider;
  engine?: EngineId;
};

export type SwitchSnapshot = {
  switches: Record<KillSwitchKey, boolean>;
  evaluatedAt: string;
  definitionsEtag: string | null;
};

function blocked(input: CaptureInput, flags: FlagKey[]): CaptureChannelDisabledError {
  console.warn("capture.blocked", { ...input, flags });
  return new CaptureChannelDisabledError(flags);
}

/**
 * Throws unless the channel, provider and engine kill switches are all on. Off is final
 * (`CaptureChannelDisabledError`); definitions not loaded yet is retryable (`FlagsNotReadyError`).
 */
export async function assertCaptureAllowed(input: CaptureInput): Promise<void> {
  const { channel, provider, engine } = input;
  const channelKey = `capture-channel-${channel}` as const satisfies FlagKey;
  if (channel === "ui-own") throw blocked(input, [channelKey]);
  const keys: FlagKey[] = [channelKey, `capture-provider-${provider}`];
  if (engine) keys.push(`capture-engine-${engine}`);
  await warmUp();
  const flags = await evaluate(keys, { kind: "system", ...input });
  if (!flags) throw new FlagsNotReadyError();
  const off = keys.filter((key) => !on(flags, key));
  if (off.length > 0) throw blocked(input, off);
}

/** Every kill switch as evaluated now, stored with each capture batch as its provenance. */
export async function captureSwitchSnapshot(): Promise<SwitchSnapshot> {
  await warmUp();
  const flags = await evaluate(KILL_SWITCH_KEYS, { kind: "system" });
  if (!flags) throw new FlagsNotReadyError();
  const switches = Object.fromEntries(KILL_SWITCH_KEYS.map((key) => [key, on(flags, key)]));
  return {
    switches: switches as Record<KillSwitchKey, boolean>,
    evaluatedAt: new Date().toISOString(),
    definitionsEtag: definitionsEtag(),
  };
}
