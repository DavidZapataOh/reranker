import { AppError } from "../errors/app-error";

/** `<measurementId>:<slotIndex>`: a slot of a frozen measurement plan. */
export type SlotId = `${string}:${number}`;

// captures.slot_index is a smallint.
export const MAX_SLOT_INDEX = 32_767;
export const SLOT_ID_PATTERN = /^([^:]+):(0|[1-9]\d*)$/;

function validIndex(slotIndex: number): boolean {
  return Number.isInteger(slotIndex) && slotIndex >= 0 && slotIndex <= MAX_SLOT_INDEX;
}

export function slotId(measurementId: string, slotIndex: number): SlotId {
  if (measurementId === "" || measurementId.includes(":") || !validIndex(slotIndex)) {
    throw new AppError("validation_failed", {
      detail: `Invalid slot ${measurementId}:${slotIndex}`,
    });
  }
  return `${measurementId}:${slotIndex}`;
}

export function parseSlotId(id: string): { measurementId: string; slotIndex: number } {
  const match = SLOT_ID_PATTERN.exec(id);
  const slotIndex = Number(match?.[2]);
  if (!match?.[1] || !validIndex(slotIndex)) {
    throw new AppError("validation_failed", { detail: `Invalid slot id ${JSON.stringify(id)}` });
  }
  return { measurementId: match[1], slotIndex };
}
