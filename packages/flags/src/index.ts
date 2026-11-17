export {
  assertCaptureAllowed,
  type CaptureInput,
  captureSwitchSnapshot,
  type SwitchSnapshot,
} from "./capture";
export { getFlagsClient } from "./client";
export { CaptureChannelDisabledError, FlagsNotReadyError } from "./errors";
export { type FlagContext, getVariant, isEnabled } from "./evaluate";
export { FLAG_KEYS, type FlagKey, KILL_SWITCH_KEYS, type KillSwitchKey } from "./flag-keys.gen";
export { enabledInProduction, gatedFlagsOn } from "./launch-gate";
export { createPostHogApi, type PostHogApi } from "./posthog-api";
export { type FlagKind, type RegistryEntry, registry } from "./registry";
