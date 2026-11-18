import { createHash } from "node:crypto";
import canonicalize from "canonicalize";

export type VariantId = `pv_${string}`;
export type IntentSetId = `is_${string}`;

const SHA256_HEX = /^[0-9a-f]{64}$/;
const encoder = new TextEncoder();

/** RFC 8785 canonical bytes; throws on values JSON cannot carry (NaN, Infinity, lone surrogates). */
export function jcs(value: unknown): Uint8Array {
  const text = canonicalize(value);
  if (text === undefined) throw new TypeError("JCS input has no JSON representation");
  return encoder.encode(text);
}

export function sha256Hex(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function contentHash(set: unknown): string {
  return sha256Hex(jcs(set));
}

export function variantId(p: {
  intentId: string;
  paraphraseId: string;
  personaId: string | null;
  geoKey: string;
}): VariantId {
  const { intentId, paraphraseId, personaId, geoKey } = p;
  return `pv_${contentHash({ intentId, paraphraseId, personaId, geoKey }).slice(0, 16)}`;
}

export function intentSetId(contentHash: string): IntentSetId {
  if (!SHA256_HEX.test(contentHash)) throw new TypeError("contentHash must be 64 lowercase hex");
  return `is_${contentHash.slice(0, 16)}`;
}

export function promptSha256(text: string): string {
  return sha256Hex(text);
}
