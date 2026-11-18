import {
  GetPublicKeyCommand,
  KMSClient,
  KMSServiceException,
  SignCommand,
} from "@aws-sdk/client-kms";
import { appEnv } from "@reranker/env";
import { KEYS_BY_ENV, type KeyPurpose, type TrustedKey } from "@reranker/verify/trust";
import { awsCredentialsProvider } from "@vercel/oidc-aws-credentials-provider";
import { requireEvidenceEnv, resetEvidenceEnv } from "./env";
import { SigningKeyMismatchError, SigningUnavailableError } from "./errors";

export interface Signer {
  keyid: string;
  publicKey: Uint8Array;
  sign(message: Uint8Array): Promise<Uint8Array>;
}

type KmsSend = Pick<KMSClient, "send">;

const KMS_TIMEOUT_MS = 2_000;
// DER SubjectPublicKeyInfo header of an Ed25519 key (RFC 8410); the raw key follows it.
const ED25519_SPKI_PREFIX = Uint8Array.from([
  0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
]);
const ED25519_PUBLIC_KEY_BYTES = 32;

const RETRYABLE = new Set([
  "ThrottlingException",
  "KMSInternalException",
  "DependencyTimeoutException",
  "KeyUnavailableException",
]);
// The key is gone, disabled, not ours or not a signing key: retrying signs nothing.
const KEY_REFUSED = new Set([
  "AccessDeniedException",
  "DisabledException",
  "KMSInvalidStateException",
  "NotFoundException",
  "InvalidKeyUsageException",
]);

async function callKms<T>(keyid: string, call: (signal: AbortSignal) => Promise<T>): Promise<T> {
  try {
    return await call(AbortSignal.timeout(KMS_TIMEOUT_MS));
  } catch (error) {
    if (!(error instanceof KMSServiceException)) {
      // No KMS response at all: network failure, timeout or abort.
      throw new SigningUnavailableError("KMS is unreachable", { cause: error });
    }
    if (KEY_REFUSED.has(error.name)) {
      throw new SigningKeyMismatchError(keyid, `KMS refused the key (${error.name})`, {
        cause: error,
      });
    }
    if (RETRYABLE.has(error.name) || error.$fault === "server") {
      throw new SigningUnavailableError(`KMS is unavailable (${error.name})`, { cause: error });
    }
    throw error;
  }
}

/** An Ed25519 signer whose private key never leaves AWS KMS. */
export function kmsSigner(opts: {
  client: KmsSend;
  keyArn: string;
  keyid: string;
  publicKey: Uint8Array;
}): Signer {
  const { client, keyArn, keyid, publicKey } = opts;
  return {
    keyid,
    publicKey,
    async sign(message) {
      const { Signature } = await callKms(keyid, (abortSignal) =>
        client.send(
          new SignCommand({
            KeyId: keyArn,
            Message: message,
            MessageType: "RAW",
            SigningAlgorithm: "ED25519_SHA_512",
          }),
          { abortSignal },
        ),
      );
      if (!Signature) throw new SigningUnavailableError("KMS returned no signature");
      return Signature;
    },
  };
}

function rawEd25519(spki: Uint8Array | undefined): Uint8Array | undefined {
  const prefix = ED25519_SPKI_PREFIX.length;
  if (spki?.length !== prefix + ED25519_PUBLIC_KEY_BYTES) return undefined;
  if (!ED25519_SPKI_PREFIX.every((byte, i) => spki[i] === byte)) return undefined;
  return spki.subarray(prefix);
}

/**
 * Checks that the KMS key holds the public key pinned in the registry before it signs anything,
 * so a swapped ARN or alias can never produce signatures that verifiers reject.
 */
export async function connectKmsSigner(opts: {
  client: KmsSend;
  keyArn: string;
  key: TrustedKey | undefined;
}): Promise<Signer> {
  const { client, keyArn, key } = opts;
  if (!key) throw new SigningKeyMismatchError("", "no current key in the registry");
  const { PublicKey } = await callKms(key.keyid, (abortSignal) =>
    client.send(new GetPublicKeyCommand({ KeyId: keyArn }), { abortSignal }),
  );
  const actual = rawEd25519(PublicKey);
  if (!actual || !Buffer.from(actual).equals(Buffer.from(key.publicKey, "base64"))) {
    throw new SigningKeyMismatchError(key.keyid, "KMS public key differs from the registry");
  }
  return kmsSigner({ client, keyArn, keyid: key.keyid, publicKey: actual });
}

function currentKey(purpose: KeyPurpose): TrustedKey | undefined {
  const keys = KEYS_BY_ENV[appEnv() === "production" ? "production" : "preview"];
  return keys.find(
    (k) => k.purpose === purpose && k.validTo === null && k.compromisedAfter === null,
  );
}

function kmsConfig(purpose: KeyPurpose) {
  const keyArnName =
    purpose === "capture" ? "EVIDENCE_CAPTURE_KMS_KEY_ARN" : "EVIDENCE_LOG_KMS_KEY_ARN";
  const env = requireEvidenceEnv("AWS_REGION", "AWS_ROLE_ARN", keyArnName);
  return { region: env.AWS_REGION, roleArn: env.AWS_ROLE_ARN, keyArn: env[keyArnName] };
}

let client: KMSClient | undefined;
const signers = new Map<KeyPurpose, Promise<Signer>>();

/** The signer for `purpose` in this environment, verified against the registry once per process. */
export function loadSigner(purpose: KeyPurpose): Promise<Signer> {
  let signer = signers.get(purpose);
  if (!signer) {
    signer = (async () => {
      const key = currentKey(purpose);
      const { region, roleArn, keyArn } = kmsConfig(purpose);
      client ??= new KMSClient({ region, credentials: awsCredentialsProvider({ roleArn }) });
      return connectKmsSigner({ client, keyArn, key });
    })();
    signers.set(purpose, signer);
    // A transient KMS or credentials failure must not poison the process.
    const pending = signer;
    pending.catch(() => {
      if (signers.get(purpose) === pending) signers.delete(purpose);
    });
  }
  return signer;
}

/** Drops the memoized signers and client so a test can change the environment. */
export function resetSigners(): void {
  signers.clear();
  client = undefined;
  resetEvidenceEnv();
}
