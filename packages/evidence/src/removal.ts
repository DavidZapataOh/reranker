import { withSystem } from "@reranker/db";
import { artifactRemovals } from "@reranker/db/schema";
import type { RemovalReason } from "@reranker/verify/format";
import { artifactUrl, checkDigest, deleteArtifact, PRIVATE_ARTIFACT_KINDS } from "./artifacts";
import { requireEvidenceEnv } from "./env";
import { EvidenceStorageUnavailableError } from "./errors";

export type RemovableKind = "raw" | "normalized" | "extractions";

const PURGE_TIMEOUT_MS = 10_000;

/**
 * Takes an artifact down for a personal-data request or a legal order. Its digest stays in the
 * signed statement and the log, so signature, inclusion and dating keep verifying; bundles then
 * show it as removed. A second call for the same digest does nothing and reports `created: false`.
 */
export async function removeArtifact(
  sha256: string,
  kind: RemovableKind,
  reason: RemovalReason,
): Promise<{ created: boolean }> {
  checkDigest(sha256);
  // Private kinds have no public URL, so no CDN copy to purge.
  const purge = PRIVATE_ARTIFACT_KINDS.has(kind)
    ? null
    : {
        url: artifactUrl(kind, sha256),
        ...requireEvidenceEnv("CLOUDFLARE_CACHE_PURGE_TOKEN", "CLOUDFLARE_ZONE_ID"),
      };

  // The record commits only once the object is gone from R2 and the CDN, so a failure leaves no
  // record and the retry does it all again; a concurrent call waits on the row and then finds it.
  return withSystem("evidence.remove_artifact", async (tx) => {
    const [recorded] = await tx
      .insert(artifactRemovals)
      .values({ sha256: Buffer.from(sha256, "hex"), kind, reason })
      .onConflictDoNothing()
      .returning({ sha256: artifactRemovals.sha256 });
    if (!recorded) return { created: false };
    await deleteArtifact(kind, sha256);
    if (purge) await purgeUrl(purge);
    return { created: true };
  });
}

// https://developers.cloudflare.com/api/resources/cache/methods/purge/
async function purgeUrl({
  url,
  CLOUDFLARE_ZONE_ID: zoneId,
  CLOUDFLARE_CACHE_PURGE_TOKEN: token,
}: {
  url: string;
  CLOUDFLARE_ZONE_ID: string;
  CLOUDFLARE_CACHE_PURGE_TOKEN: string;
}): Promise<void> {
  const endpoint = `https://api.cloudflare.com/client/v4/zones/${zoneId}/purge_cache`;
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ files: [url] }),
      signal: AbortSignal.timeout(PURGE_TIMEOUT_MS),
    });
  } catch (error) {
    throw new EvidenceStorageUnavailableError(`Cloudflare cache purge of ${url} failed`, {
      cause: error,
    });
  }
  const body = (await response.json().catch(() => null)) as {
    success?: boolean;
    errors?: Array<{ code: number; message: string }>;
  } | null;
  if (response.ok && body?.success === true) return;
  const detail = body?.errors?.map((e) => `${e.code} ${e.message}`).join("; ") ?? "";
  const message = `Cloudflare cache purge of ${url}: HTTP ${response.status}${detail ? ` (${detail})` : ""}`;
  if (response.status === 429 || response.status >= 500) {
    throw new EvidenceStorageUnavailableError(message);
  }
  throw new Error(message);
}
