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

/**
 * Pinned in the package so a verifier never trusts keys served by the party it is checking.
 *
 * Log keys sign checkpoints under the log's origin as key name (c2sp.org/signed-note), so the
 * verifier derives the note key ID from the origin it checks and the pinned public key. Each
 * preview deployment has its own origin and they all share the one preview log key.
 */
export const KEYS_BY_ENV: Record<"production" | "preview", readonly TrustedKey[]> = {
  production: [
    {
      keyid: "rr-capture-2026-1-ed25519",
      purpose: "capture",
      env: "production",
      alg: "Ed25519",
      publicKey: "VzQD8iJrsOuZiQx6CR0FTQVg9PsVS4gKgkv/5jgBrjI=",
      custody: "aws-kms-hsm",
      validFrom: "2026-11-20T18:29:31.132Z",
      validTo: null,
      compromisedAfter: null,
    },
    {
      keyid: "rr-log-2026-1",
      purpose: "log",
      env: "production",
      alg: "Ed25519",
      publicKey: "0FtErI6+DHMnnvQmyylWOUiWwLLBeO7XT5MZpXw2e8A=",
      custody: "aws-kms-hsm",
      validFrom: "2026-11-20T18:29:31.600Z",
      validTo: null,
      compromisedAfter: null,
    },
  ],
  preview: [
    {
      keyid: "rr-capture-preview-2026-1-ed25519",
      purpose: "capture",
      env: "preview",
      alg: "Ed25519",
      publicKey: "Y5WRGvOzwMD3HGaDzJZXrjGGvEkvpoEyE0v865pgnJc=",
      custody: "aws-kms-hsm",
      validFrom: "2026-11-20T18:29:31.957Z",
      validTo: null,
      compromisedAfter: null,
    },
    {
      keyid: "rr-log-preview-2026-1",
      purpose: "log",
      env: "preview",
      alg: "Ed25519",
      publicKey: "ZTPYxiym8YfFt7vr1/K8bJu6i4nSyY1xniFZrZ9emWU=",
      custody: "aws-kms-hsm",
      validFrom: "2026-11-20T18:29:32.321Z",
      validTo: null,
      compromisedAfter: null,
    },
  ],
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
