import { bytesToHex } from "@noble/hashes/utils.js";
import {
  defaultHeaderCache,
  defaultHeaderSources,
  fetchHeader,
  type HeaderCache,
  type HeaderSource,
} from "./bitcoin";
import type { Check } from "./dsse";
import { bitcoinAttestations, parseDetachedOts } from "./format/index";

export type DateCheck = Check & { datedBefore?: string; bitcoinHeight?: number; source?: string };

const LOOKUP_FAILURE: Record<"forged" | "disagree" | "unavailable", DateCheck> = {
  forged: { status: "fail", detail: "header_mismatch" },
  disagree: { status: "unavailable", detail: "explorers_disagree" },
  unavailable: { status: "unavailable", detail: "explorers_unavailable" },
};

/**
 * Dates a checkpoint with its detached OpenTimestamps proof: each Bitcoin attestation, earliest
 * first, holds when the commitment it replays to is the merkle root of that block's header, as
 * python-opentimestamps' BitcoinBlockHeaderAttestation.verify_against_blockheader checks. The
 * block's nTime is then the time the checkpoint existed before.
 */
export async function verifyOtsDate(p: {
  checkpointDigest: Uint8Array;
  ots: Uint8Array | null;
  sources?: readonly HeaderSource[];
  cache?: HeaderCache;
  fetch?: typeof fetch;
  signal?: AbortSignal;
}): Promise<DateCheck> {
  if (!p.ots) return { status: "pending", detail: "no_proof" };
  let proof: ReturnType<typeof parseDetachedOts>;
  try {
    proof = parseDetachedOts(p.ots);
  } catch {
    return { status: "fail", detail: "invalid_proof" };
  }
  if (bytesToHex(proof.digest) !== bytesToHex(p.checkpointDigest)) {
    return { status: "fail", detail: "digest_mismatch" };
  }
  const attestations = bitcoinAttestations(proof.timestamp).sort((a, b) => a.height - b.height);
  if (attestations.length === 0) return { status: "pending", detail: "not_confirmed" };

  const sources = p.sources ?? defaultHeaderSources(p.fetch);
  const cache = p.cache ?? defaultHeaderCache();
  const failures: DateCheck[] = [];
  for (const { height, commitment } of attestations) {
    const lookup = await fetchHeader(height, sources, { cache, signal: p.signal });
    if (lookup.status !== "found") {
      failures.push(LOOKUP_FAILURE[lookup.status]);
      continue;
    }
    const { header } = lookup;
    if (bytesToHex(header.slice(36, 68).reverse()) !== commitment) {
      failures.push({ status: "fail", detail: "commitment_mismatch" });
      continue;
    }
    const time = new DataView(header.buffer, header.byteOffset, header.length).getUint32(68, true);
    return {
      status: "pass",
      bitcoinHeight: height,
      datedBefore: new Date(time * 1000).toISOString(),
      ...(lookup.sources.length > 0 && { source: lookup.sources.join(", ") }),
    };
  }
  // A block that could not be read may still hold the commitment, so that outranks a mismatch.
  return failures.find((f) => f.status === "unavailable") ?? (failures[0] as DateCheck);
}
