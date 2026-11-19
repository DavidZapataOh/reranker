import { bytesToHex, concatBytes } from "@noble/hashes/utils.js";
import { withTimeout } from "./bitcoin";
import type { Check } from "./dsse";
import { ARTIFACTS_ORIGIN } from "./format/index";

export const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 5_000;
const SHA256_HEX = /^[0-9a-f]{64}$/;

class TooLargeError extends Error {
  override readonly name = "TooLargeError";
}

/** Reads a body up to `limit` bytes, cancelling the stream as soon as it goes past it. */
export async function readCapped(response: Response, limit: number): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  if (Number(response.headers.get("content-length")) > limit) {
    await response.body.cancel();
    throw new TooLargeError();
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return concatBytes(...chunks);
    size += value.length;
    if (size > limit) {
      await reader.cancel();
      throw new TooLargeError();
    }
    chunks.push(value);
  }
}

export const isTooLarge = (error: unknown) => error instanceof TooLargeError;

/**
 * Downloads an artifact from the URL its digest derives under `origin` and checks the bytes hash to
 * that digest. Artifacts are stored gzipped with `Content-Encoding: gzip`, which fetch undoes.
 */
export async function fetchArtifact(
  kind: "raw" | "normalized",
  sha256: string,
  opts: { fetch: typeof fetch; signal?: AbortSignal; origin?: string },
): Promise<{ check: Check; bytes?: Uint8Array }> {
  if (!SHA256_HEX.test(sha256)) return { check: { status: "fail", detail: "invalid_digest" } };
  const timeout = withTimeout(opts.signal, TIMEOUT_MS);
  let bytes: Uint8Array;
  try {
    const response = await opts.fetch(`${opts.origin ?? ARTIFACTS_ORIGIN}/${kind}/${sha256}`, {
      signal: timeout.signal,
    });
    if (!response.ok) {
      await response.body?.cancel();
      const detail = response.status === 404 ? "not_found" : `http_${response.status}`;
      return { check: { status: "unavailable", detail } };
    }
    bytes = await readCapped(response, MAX_ARTIFACT_BYTES);
  } catch (error) {
    if (isTooLarge(error)) return { check: { status: "fail", detail: "too_large" } };
    return { check: { status: "unavailable", detail: "network" } };
  } finally {
    timeout.clear();
  }
  const digest = bytesToHex(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>)),
  );
  if (digest !== sha256) return { check: { status: "fail", detail: "digest_mismatch" } };
  return { check: { status: "pass" }, bytes };
}
