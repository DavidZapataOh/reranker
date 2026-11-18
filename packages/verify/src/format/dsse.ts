import * as z from "zod/mini";

export const DSSE_PAYLOAD_TYPE = "application/vnd.in-toto+json";
/** AWS KMS signs RAW messages of at most 4096 bytes; signers check the PAE against it. */
export const MAX_PAE_BYTES = 4096;

export interface DsseSignature {
  keyid: string;
  sig: string;
}

export interface DsseEnvelope {
  payloadType: typeof DSSE_PAYLOAD_TYPE;
  payload: string;
  signatures: DsseSignature[];
}

export const DsseEnvelopeSchema: z.ZodMiniType<DsseEnvelope> = z.strictObject({
  payloadType: z.literal(DSSE_PAYLOAD_TYPE),
  payload: z.base64(),
  signatures: z
    .array(z.strictObject({ keyid: z.string().check(z.minLength(1)), sig: z.base64() }))
    .check(z.minLength(1)),
});

const encoder = new TextEncoder();

/** DSSE pre-authentication encoding: "DSSEv1" SP LEN(type) SP type SP LEN(body) SP body. */
export function pae(payloadType: string, body: Uint8Array): Uint8Array {
  const type = encoder.encode(payloadType);
  const header = encoder.encode(`DSSEv1 ${type.length} ${payloadType} ${body.length} `);
  const out = new Uint8Array(header.length + body.length);
  out.set(header);
  out.set(body, header.length);
  return out;
}

const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;

function jsonString(value: unknown, field: string): string {
  if (typeof value !== "string" || !PRINTABLE_ASCII.test(value)) {
    throw new TypeError(`DSSE envelope ${field} must be a printable ASCII string`);
  }
  return JSON.stringify(value);
}

function exactObject(value: unknown, keys: readonly string[], what: string) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${what} must be an object`);
  }
  if (Object.keys(value).length !== keys.length || !keys.every((k) => Object.hasOwn(value, k))) {
    throw new TypeError(`${what} must have exactly the fields ${keys.join(", ")}`);
  }
  return value as Record<string, unknown>;
}

/**
 * RFC 8785 (JCS) bytes of the envelope, the input of its log leaf. With printable ASCII strings
 * only, JCS is sorted keys plus JSON.stringify per value; anything else is rejected rather than
 * risk bytes another JCS implementation would not reproduce.
 */
export function envelopeBytes(envelope: DsseEnvelope): Uint8Array {
  const env = exactObject(envelope, ["payload", "payloadType", "signatures"], "DSSE envelope");
  if (!Array.isArray(env.signatures)) {
    throw new TypeError("DSSE envelope signatures must be an array");
  }
  const signatures = env.signatures.map((entry: unknown) => {
    const s = exactObject(entry, ["keyid", "sig"], "DSSE signature");
    return `{"keyid":${jsonString(s.keyid, "keyid")},"sig":${jsonString(s.sig, "sig")}}`;
  });
  const payload = jsonString(env.payload, "payload");
  const payloadType = jsonString(env.payloadType, "payloadType");
  return encoder.encode(
    `{"payload":${payload},"payloadType":${payloadType},"signatures":[${signatures.join(",")}]}`,
  );
}
