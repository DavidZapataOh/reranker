import * as z from "zod/mini";
import { type DsseEnvelope, DsseEnvelopeSchema } from "./dsse";
import type { CaptureId } from "./ids";
import { captureIdSchema, sha256Hex } from "./schema";

export const BUNDLE_MEDIA_TYPE = "application/vnd.reranker.bundle+json";
export const ARTIFACTS_ORIGIN = "https://ev.reranker.co";
export const LOG_ORIGIN = "log.reranker.co/captures/2026";
export const LOG_BASE_URL = `https://${LOG_ORIGIN}`;

export type RemovalReason = "personal_data_request" | "legal_order";

export type BundleArtifact =
  | { sha256: string; status: "available" }
  | { sha256: string; status: "removed"; removed_at: string; reason: RemovalReason };

/**
 * Artifact URLs never travel in the bundle: verifiers derive them from the digest under
 * ARTIFACTS_ORIGIN, so a tampered bundle cannot point elsewhere. Proof hashes are base64.
 */
export interface EvidenceBundleV1 {
  version: 1;
  capture_id: CaptureId;
  envelope: DsseEnvelope;
  artifacts: Record<"raw" | "normalized", BundleArtifact>;
  inclusion: { log: string; index: number; tree_size: number; hashes: string[] };
  checkpoint: string;
  latest: { checkpoint: string; consistency: string[] };
  anchors: {
    ots: { status: "pending" | "confirmed"; proof: string; bitcoin_height: number | null } | null;
    tsr: Array<{ provider: "qtsa" | "digicert"; proof: string }>;
  };
  rekor: null;
  plan: null;
  tlsn: null;
}

const count = z.int().check(z.nonnegative());
const note = z.string().check(z.minLength(1));

const artifact = z.discriminatedUnion("status", [
  z.strictObject({ sha256: sha256Hex, status: z.literal("available") }),
  z.strictObject({
    sha256: sha256Hex,
    status: z.literal("removed"),
    removed_at: z.iso.datetime(),
    reason: z.enum(["personal_data_request", "legal_order"]),
  }),
]);

export const EvidenceBundleV1Schema: z.ZodMiniType<EvidenceBundleV1> = z.strictObject({
  version: z.literal(1),
  capture_id: captureIdSchema,
  envelope: DsseEnvelopeSchema,
  artifacts: z.strictObject({ raw: artifact, normalized: artifact }),
  inclusion: z
    .strictObject({ log: note, index: count, tree_size: count, hashes: z.array(z.base64()) })
    .check(
      z.refine(
        (inclusion) => inclusion.index < inclusion.tree_size,
        "index must be inside the tree",
      ),
    ),
  checkpoint: note,
  latest: z.strictObject({ checkpoint: note, consistency: z.array(z.base64()) }),
  anchors: z.strictObject({
    ots: z.nullable(
      z.strictObject({
        status: z.enum(["pending", "confirmed"]),
        proof: z.base64(),
        bitcoin_height: z.nullable(count),
      }),
    ),
    tsr: z.array(z.strictObject({ provider: z.enum(["qtsa", "digicert"]), proof: z.base64() })),
  }),
  rekor: z.null(),
  plan: z.null(),
  tlsn: z.null(),
});
