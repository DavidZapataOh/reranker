import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

export type KeyPurpose = "capture" | "log";

export interface TrustedKey {
  keyid: string;
  purpose: KeyPurpose;
  env: "production" | "preview";
  alg: "Ed25519";
  /** Base64 of the 32-byte RFC 8032 public key. */
  publicKey: string;
  custody: "aws-kms-hsm" | "gcp-kms-software";
  validFrom: string;
  validTo: string | null;
  /** Signatures made after this instant are not trusted, even inside the validity window. */
  compromisedAfter: string | null;
}

/** Pinned in the package so a verifier never trusts keys served by the party it is checking. */
export const KEYS_BY_ENV: Record<"production" | "preview", readonly TrustedKey[]> = {
  production: [],
  preview: [],
};

export const TRUSTED_KEYS: readonly TrustedKey[] = KEYS_BY_ENV.production;

const ED25519_SIGNATURE_TYPE = 0x01;
const encoder = new TextEncoder();

function checkNoteKey(name: string, publicKey: Uint8Array): void {
  // c2sp.org/signed-note: key names are non-empty and contain no whitespace or "+".
  if (!/^[^\s+]+$/u.test(name)) throw new TypeError("note key name is invalid");
  if (publicKey.length !== 32) throw new TypeError("Ed25519 public keys are 32 bytes");
}

/** c2sp.org/signed-note key ID: SHA-256(name ‖ 0x0A ‖ 0x01 ‖ public key)[:4]. */
export function noteKeyId(name: string, publicKey: Uint8Array): Uint8Array {
  checkNoteKey(name, publicKey);
  const nameBytes = encoder.encode(name);
  const input = new Uint8Array(nameBytes.length + 2 + publicKey.length);
  input.set(nameBytes);
  input[nameBytes.length] = 0x0a;
  input[nameBytes.length + 1] = ED25519_SIGNATURE_TYPE;
  input.set(publicKey, nameBytes.length + 2);
  return sha256(input).subarray(0, 4);
}

/** c2sp.org/signed-note verifier key: "<name>+<hex key ID>+<base64(0x01 ‖ public key)>". */
export function noteVerifierKey(name: string, publicKey: Uint8Array): string {
  const keyId = bytesToHex(noteKeyId(name, publicKey));
  return `${name}+${keyId}+${btoa(String.fromCharCode(ED25519_SIGNATURE_TYPE, ...publicKey))}`;
}
