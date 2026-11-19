import { InvalidInputError } from "@reranker/jobs/errors";
import {
  slotId as formatSlot,
  type PlannedSlot,
  parseSlotId as parseSlot,
  type SlotId,
} from "@reranker/schema/measurement";
import type { CaptureId } from "@reranker/verify/format";
import { monotonicFactory } from "ulid";

export type { SlotId };

export type FrozenSlot = PlannedSlot & { measurementId: string; slotIndex: number; slotId: SlotId };

// Capture steps treat a bad slot as an input error that a retry cannot fix.
export function slotId(measurementId: string, slotIndex: number): SlotId {
  try {
    return formatSlot(measurementId, slotIndex);
  } catch (cause) {
    throw new InvalidInputError(`Invalid slot ${measurementId}:${slotIndex}`, { cause });
  }
}

export function parseSlotId(id: string): { measurementId: string; slotIndex: number } {
  try {
    return parseSlot(id);
  } catch (cause) {
    throw new InvalidInputError(`Invalid slot id ${JSON.stringify(id)}`, { cause });
  }
}

// Monotonic, so ids minted in the same millisecond still sort in creation order.
const ulid = monotonicFactory();

/** One per attempt: it names the capture in its signed statement and in the captures table. */
export function newCaptureId(): CaptureId {
  return `cap_${ulid()}`;
}
