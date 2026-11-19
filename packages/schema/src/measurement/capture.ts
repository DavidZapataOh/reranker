import type { CaptureChannel, EngineId } from "../domain";

export type CaptureStatus = "succeeded" | "provider_error" | "timeout";

/** A stored capture attempt of one plan slot. */
export interface CaptureAttempt {
  id: string;
  engine: EngineId;
  channel: CaptureChannel;
  status: CaptureStatus;
  modelReported: string | null;
  slotId: string;
}

/**
 * A capture attempt with its normalized answer, null when the attempt failed. The answer type
 * stays open so packages that only read `present` need not depend on the capture parsers.
 */
export interface RawCaptureOf<Answer extends { present: boolean }> {
  capture: CaptureAttempt;
  answer: Answer | null;
}
