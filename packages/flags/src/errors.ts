import type { FlagKey } from "./flag-keys.gen";

/** A kill switch is off: the capture must not run and retrying cannot change that. */
export class CaptureChannelDisabledError extends Error {
  override readonly name = "CaptureChannelDisabledError";
  readonly retryable = false;
  readonly flags: FlagKey[];

  constructor(flags: FlagKey[]) {
    super(`Capture disabled by ${flags.join(", ")}`);
    this.flags = flags;
  }
}

/** Flag definitions are not loaded yet, so nothing can be allowed; the next poll may fix it. */
export class FlagsNotReadyError extends Error {
  override readonly name = "FlagsNotReadyError";
  readonly retryable = true;
  readonly retryAfterMs = 30_000;

  constructor() {
    super("Feature flag definitions are not loaded");
  }
}
