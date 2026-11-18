import { createHash } from "node:crypto";
import {
  DSSE_PAYLOAD_TYPE,
  type DsseEnvelope,
  envelopeBytes,
  MAX_PAE_BYTES,
  pae,
} from "@reranker/verify/format";
import { SigningKeyMismatchError, StatementTooLargeError } from "./errors";
import type { Signer } from "./signer";

const ED25519_SIGNATURE_BYTES = 64;

const base64 = (bytes: Uint8Array) =>
  Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");

/**
 * Signs `payload` as an in-toto DSSE envelope with every signer (several during a key rotation)
 * and returns the JCS bytes that become the log leaf, with their SHA-256.
 */
export async function signEnvelope(
  payload: Uint8Array,
  signers: readonly Signer[],
): Promise<{ envelope: DsseEnvelope; bytes: Uint8Array; sha256: string }> {
  if (signers.length === 0) throw new TypeError("a DSSE envelope needs at least one signer");
  const message = pae(DSSE_PAYLOAD_TYPE, payload);
  if (message.length > MAX_PAE_BYTES) {
    throw new StatementTooLargeError(message.length, MAX_PAE_BYTES);
  }
  const signatures = await Promise.all(
    signers.map(async (signer) => {
      const sig = await signer.sign(message);
      if (sig.length !== ED25519_SIGNATURE_BYTES) {
        throw new SigningKeyMismatchError(
          signer.keyid,
          `returned a ${sig.length}-byte signature, not Ed25519`,
        );
      }
      return { keyid: signer.keyid, sig: base64(sig) };
    }),
  );
  const envelope: DsseEnvelope = {
    payloadType: DSSE_PAYLOAD_TYPE,
    payload: base64(payload),
    signatures,
  };
  const bytes = envelopeBytes(envelope);
  return { envelope, bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
}
