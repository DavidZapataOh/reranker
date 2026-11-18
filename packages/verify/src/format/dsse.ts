import * as z from "zod/mini";

export const IN_TOTO_PAYLOAD_TYPE = "application/vnd.in-toto+json";

export interface DsseSignature {
  keyid: string;
  sig: string;
}

export interface DsseEnvelope {
  payloadType: typeof IN_TOTO_PAYLOAD_TYPE;
  payload: string;
  signatures: DsseSignature[];
}

export const DsseEnvelopeSchema: z.ZodMiniType<DsseEnvelope> = z.strictObject({
  payloadType: z.literal(IN_TOTO_PAYLOAD_TYPE),
  payload: z.base64(),
  signatures: z
    .array(z.strictObject({ keyid: z.string().check(z.minLength(1)), sig: z.base64() }))
    .check(z.minLength(1)),
});
