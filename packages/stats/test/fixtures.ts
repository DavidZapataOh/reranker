import fc from "fast-check";
import type { CaptureFrame, EntityColumn } from "../src/compare";
import type { EntityObservation } from "../src/score";

export const hexSeed = fc.stringMatching(/^[0-9a-f]{64}$/).filter((s) => !/^0{32}/.test(s));

export function obs(over: Partial<EntityObservation> = {}): EntityObservation {
  return {
    captureIndex: 0,
    stratum: "s",
    weight: 1,
    y: 0,
    ordinal: null,
    isCanonical: false,
    ...over,
  };
}

// V0 shape: 5 engines × 5 intents, 8 captures each, equal weights.
export function frameOf(strata: number, perStratum: number): CaptureFrame {
  return {
    captures: Array.from({ length: strata * perStratum }, (_, i) => ({
      stratum: `s${Math.floor(i / perStratum)}`,
      weight: 1 / strata,
    })),
  };
}

// Recommendations spread over the frame (every `step`-th capture) so they fall in many strata.
export function col(
  key: string,
  recs: number,
  { size = 40, ordinal = 1, offset = 0 }: { size?: number; ordinal?: number; offset?: number } = {},
): EntityColumn {
  const y = new Uint8Array(size);
  const ord = new Int16Array(size);
  const step = Math.max(1, Math.floor(size / Math.max(recs, 1)));
  for (let r = 0; r < recs; r++) {
    const i = (offset + r * step) % size;
    y[i] = 1;
    ord[i] = ordinal;
  }
  return { key, y, ordinal: ord };
}
