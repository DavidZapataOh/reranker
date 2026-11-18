import { createHash } from "node:crypto";
import { merkleRoot as rfc6962Root } from "@reranker/verify/format";
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

export type VariantTemplate = {
  intentId: string;
  paraphraseId: string;
  format: string;
  text: string;
  personaId: string | null;
  preamble: string | null;
};

type TemplateSource = {
  intents: readonly { intentId: string; categoryKey: string }[];
  paraphrases: readonly { paraphraseId: string; intentId: string; format: string; text: string }[];
  personas: readonly { personaId: string; categoryKey: string; preamble: string }[];
};

/** Every paraphrase of every intent, once without a persona and once per persona of its category. */
export function variantTemplates(set: TemplateSource): VariantTemplate[] {
  const categoryOf = new Map(set.intents.map((i) => [i.intentId, i.categoryKey]));
  const personasOf = Map.groupBy(set.personas, (p) => p.categoryKey);
  return set.paraphrases.flatMap(({ intentId, paraphraseId, format, text }) => {
    const category = categoryOf.get(intentId);
    if (category === undefined) throw new TypeError(`paraphrase ${paraphraseId} has no intent`);
    const base = { intentId, paraphraseId, format, text };
    return [
      { ...base, personaId: null, preamble: null },
      ...(personasOf.get(category) ?? []).map((p) => ({
        ...base,
        personaId: p.personaId,
        preamble: p.preamble,
      })),
    ];
  });
}

/**
 * RFC 6962 root over the leaves sha256(JCS(template)), sorted so the root depends on the set of
 * templates and not on the order a file or a generator happened to list them.
 */
export function merkleRoot(variantTemplates: readonly unknown[]): string {
  const leaves = variantTemplates.map((t) => sha256Hex(jcs(t))).sort();
  return Buffer.from(rfc6962Root(leaves.map((hex) => Buffer.from(hex, "hex")))).toString("hex");
}
