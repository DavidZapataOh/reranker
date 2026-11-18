import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { InvalidInputError } from "@reranker/jobs/errors";
import { log } from "@reranker/telemetry";
import { AwsClient } from "aws4fetch";
import { type EvidenceEnv, getEvidenceEnv, requireEvidenceEnv } from "./env";
import { EvidenceStorageUnavailableError } from "./errors";

export type ArtifactKind =
  | "raw"
  | "request"
  | "normalized"
  | "plans"
  | "envelopes"
  | "intent-sets"
  | "extractions";

/** Kinds stored in the internal bucket, which has no public domain: they may name professionals. */
export const PRIVATE_ARTIFACT_KINDS: ReadonlySet<ArtifactKind> = new Set(["extractions"]);

const TIMEOUT_MS = 5_000;
// aws4fetch retries 5xx and 429 itself; three jittered retries fit inside the timeout, and the
// job that called us retries the whole step after that.
const RETRIES = 3;
const YEAR = "max-age=31536000, immutable";
const SHA256_HEX = /^[0-9a-f]{64}$/;
// Slash-separated segments that never start with a dot, so a key cannot climb out of the bucket.
const LOG_KEY = /^[\w-][\w.-]*(\/[\w-][\w.-]*)*$/;

let storage: { env: EvidenceEnv; client: AwsClient; endpoint: string } | undefined;

function r2() {
  const env = getEvidenceEnv();
  if (storage?.env !== env) {
    const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY } = requireEvidenceEnv(
      "R2_ACCOUNT_ID",
      "R2_ACCESS_KEY_ID",
      "R2_SECRET_ACCESS_KEY",
    );
    storage = {
      env,
      endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      client: new AwsClient({
        accessKeyId: R2_ACCESS_KEY_ID,
        secretAccessKey: R2_SECRET_ACCESS_KEY,
        service: "s3",
        region: "auto",
        retries: RETRIES,
      }),
    };
  }
  return storage;
}

function bucketFor(kind: ArtifactKind): string {
  return PRIVATE_ARTIFACT_KINDS.has(kind)
    ? requireEvidenceEnv("R2_INTERNAL_BUCKET").R2_INTERNAL_BUCKET
    : requireEvidenceEnv("R2_EVIDENCE_BUCKET").R2_EVIDENCE_BUCKET;
}

function checkDigest(sha256: string): void {
  if (!SHA256_HEX.test(sha256)) {
    throw new InvalidInputError("An artifact key is a lowercase hex SHA-256 digest");
  }
}

function checkLogKey(key: string): void {
  if (!LOG_KEY.test(key)) throw new InvalidInputError(`Invalid log object key: ${key}`);
}

async function send(
  method: "GET" | "PUT" | "DELETE",
  bucket: string,
  key: string,
  init: { headers?: Record<string, string>; body?: Uint8Array<ArrayBuffer> } = {},
): Promise<Response> {
  const { client, endpoint } = r2();
  const target = `${bucket}/${key}`;
  let response: Response;
  try {
    response = await client.fetch(`${endpoint}/${target}`, {
      method,
      ...init,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    throw new EvidenceStorageUnavailableError(`R2 ${method} ${target} failed`, { cause: error });
  }
  if (response.status >= 500 || response.status === 429) {
    await response.body?.cancel();
    throw new EvidenceStorageUnavailableError(`R2 ${method} ${target}: ${response.status}`);
  }
  return response;
}

async function put(
  bucket: string,
  key: string,
  body: Uint8Array<ArrayBuffer>,
  headers: Record<string, string>,
): Promise<boolean> {
  const response = await send("PUT", bucket, key, { headers, body });
  await response.body?.cancel();
  if (response.ok) return true;
  // If-None-Match: * lost to an object already at the key; content addressing makes it ours.
  if (response.status === 412 && headers["If-None-Match"] === "*") return false;
  throw new Error(`R2 PUT ${bucket}/${key}: ${response.status}`);
}

async function get(bucket: string, key: string): Promise<Uint8Array | null> {
  const response = await send("GET", bucket, key);
  if (response.status === 404) {
    await response.body?.cancel();
    return null;
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`R2 GET ${bucket}/${key}: ${response.status}`);
  }
  try {
    // fetch already undoes the gzip Content-Encoding the object was stored with.
    return new Uint8Array(await response.arrayBuffer());
  } catch (error) {
    throw new EvidenceStorageUnavailableError(`R2 GET ${bucket}/${key} broke off`, {
      cause: error,
    });
  }
}

const sha256Hex = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/**
 * Stores bytes under the SHA-256 of their uncompressed form, gzipped, written once: a second
 * write of the same bytes is a no-op that reports `created: false`.
 */
export async function putArtifact(
  kind: ArtifactKind,
  bytes: Uint8Array,
  opts: { contentType: string },
): Promise<{ sha256: string; created: boolean }> {
  const sha256 = sha256Hex(bytes);
  const created = await put(bucketFor(kind), `${kind}/${sha256}`, gzipSync(bytes), {
    "Content-Type": opts.contentType,
    "Content-Encoding": "gzip",
    "Cache-Control": `${PRIVATE_ARTIFACT_KINDS.has(kind) ? "private" : "public"}, ${YEAR}`,
    "If-None-Match": "*",
  });
  return { sha256, created };
}

/** The artifact's bytes, or null when it is absent or its bytes no longer match its digest. */
export async function getArtifact(kind: ArtifactKind, sha256: string): Promise<Uint8Array | null> {
  checkDigest(sha256);
  const bytes = await get(bucketFor(kind), `${kind}/${sha256}`);
  if (bytes === null) return null;
  if (sha256Hex(bytes) !== sha256) {
    log.error("evidence.artifact.digest_mismatch", { kind, sha256 });
    return null;
  }
  return bytes;
}

/** Public URL of an artifact; private kinds have none. */
export function artifactUrl(kind: ArtifactKind, sha256: string): string {
  checkDigest(sha256);
  if (PRIVATE_ARTIFACT_KINDS.has(kind)) {
    throw new InvalidInputError(`${kind} artifacts are never served publicly`);
  }
  const { EVIDENCE_ARTIFACTS_BASE_URL } = requireEvidenceEnv("EVIDENCE_ARTIFACTS_BASE_URL");
  return `${EVIDENCE_ARTIFACTS_BASE_URL}/${kind}/${sha256}`;
}

/** Removes an artifact; reserved for personal-data removal requests. */
export async function deleteArtifact(kind: ArtifactKind, sha256: string): Promise<void> {
  checkDigest(sha256);
  const bucket = bucketFor(kind);
  const response = await send("DELETE", bucket, `${kind}/${sha256}`);
  await response.body?.cancel();
  if (!response.ok && response.status !== 404) {
    throw new Error(`R2 DELETE ${bucket}/${kind}/${sha256}: ${response.status}`);
  }
}

/**
 * Writes a transparency log object as is. Tiles are immutable and written once; the checkpoint
 * is replaced and must be revalidated by every reader.
 */
export async function putLogObject(
  key: string,
  bytes: Uint8Array<ArrayBuffer>,
  opts: { immutable: boolean; contentType: string },
): Promise<void> {
  checkLogKey(key);
  const { R2_LOG_BUCKET } = requireEvidenceEnv("R2_LOG_BUCKET");
  await put(
    R2_LOG_BUCKET,
    key,
    bytes,
    opts.immutable
      ? {
          "Content-Type": opts.contentType,
          "Cache-Control": `public, ${YEAR}`,
          "If-None-Match": "*",
        }
      : { "Content-Type": opts.contentType, "Cache-Control": "no-cache" },
  );
}

export async function getLogObject(key: string): Promise<Uint8Array | null> {
  checkLogKey(key);
  return get(requireEvidenceEnv("R2_LOG_BUCKET").R2_LOG_BUCKET, key);
}
