export type CaptureId = `cap_${string}`;

// ULID in Crockford base32: no I, L, O or U, uppercase only.
export const CAPTURE_ID_PATTERN = /^cap_[0-9A-HJKMNP-TV-Z]{26}$/;

export function isCaptureId(value: string): value is CaptureId {
  return CAPTURE_ID_PATTERN.test(value);
}
