import { InvalidInputError } from "@reranker/jobs/errors";
import type { PlannedSlot } from "@reranker/schema/measurement";
import type { CaptureId } from "@reranker/verify/format";
import { monotonicFactory } from "ulid";

export type SlotId = `${string}:${number}`;

export type FrozenSlot = PlannedSlot & { measurementId: string; slotIndex: number; slotId: SlotId };

// captures.slot_index is a smallint.
const MAX_SLOT_INDEX = 32_767;
const SLOT_ID = /^([^:]+):(0|[1-9]\d*)$/;

function validIndex(slotIndex: number): boolean {
  return Number.isInteger(slotIndex) && slotIndex >= 0 && slotIndex <= MAX_SLOT_INDEX;
}

export function slotId(measurementId: string, slotIndex: number): SlotId {
  if (measurementId === "" || measurementId.includes(":") || !validIndex(slotIndex)) {
    throw new InvalidInputError(`Invalid slot ${measurementId}:${slotIndex}`);
  }
  return `${measurementId}:${slotIndex}`;
}

export function parseSlotId(id: string): { measurementId: string; slotIndex: number } {
  const match = SLOT_ID.exec(id);
  const slotIndex = Number(match?.[2]);
  if (!match?.[1] || !validIndex(slotIndex)) {
    throw new InvalidInputError(`Invalid slot id ${JSON.stringify(id)}`);
  }
  return { measurementId: match[1], slotIndex };
}

// Monotonic, so ids minted in the same millisecond still sort in creation order.
const ulid = monotonicFactory();

/** One per attempt: it names the capture in its signed statement and in the captures table. */
export function newCaptureId(): CaptureId {
  return `cap_${ulid()}`;
}
