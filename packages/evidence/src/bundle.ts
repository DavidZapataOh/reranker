import { withSystem } from "@reranker/db";
import type {
  BundleArtifact,
  CaptureId,
  EvidenceBundleV1,
  RemovalReason,
} from "@reranker/verify/format";
import { type SQL, sql } from "drizzle-orm";
import { readHashes } from "./log/tiles";
import { proveRecord, proveTree } from "./log/tlog";
import { logOrigin, readStatement, subjectDigest } from "./seal";

export interface SealSummary {
  captureId: CaptureId;
  savedAt: Date;
  status: "signed" | "logged" | "dated";
  datedBefore: Date | null;
  verifyUrl: string;
}

type BundleRow = {
  envelope_sha256: Buffer;
  normalized_sha256: Buffer | null;
  log_index: string;
  tree_size: string | null;
  checkpoint_note: string | null;
  latest_size: string | null;
  latest_note: string | null;
  ots_status: "pending" | "confirmed" | null;
  ots_proof: Buffer | null;
  bitcoin_height: number | null;
  tsr_providers: Array<"qtsa" | "digicert"> | null;
  tsr_proofs: Buffer[] | null;
};

type SummaryRow = {
  id: CaptureId;
  captured_at: Date;
  logged: boolean | null;
  attested_at: Date | null;
};

type Removal = { removed_at: Date; reason: RemovalReason };

const VERIFY_BASE_URL = "https://reranker.co/verificar/";

const toHex = (bytes: Buffer) => bytes.toString("hex");
const toBase64 = (bytes: Uint8Array) =>
  Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");

/** The public page where anyone can check a capture's seal. */
export function verifyUrl(captureId: CaptureId): string {
  return `${VERIFY_BASE_URL}${captureId}`;
}

/**
 * The capture's row and the published batch its proofs go against: the first one whose
 * checkpoint Bitcoin confirmed, else the first one sent to the calendars, else the first one
 * holding it. Anchors cover only the hourly checkpoint, so preferring an anchored batch keeps the
 * bundle's checkpoint the one its timestamps are about.
 */
export function bundleQuery(captureId: CaptureId, origin: string): SQL {
  return sql`
    select c.envelope_sha256, c.normalized_sha256, c.log_index,
      b.tree_size, b.checkpoint_note, l.tree_size as latest_size, l.checkpoint_note as latest_note,
      o.status as ots_status, o.proof as ots_proof, o.bitcoin_height,
      t.providers as tsr_providers, t.proofs as tsr_proofs
    from public_panel.captures c
    left join lateral (
      select coalesce(
        (select a.tree_size from public_panel.timestamp_anchors a
         where a.origin = ${origin} and a.kind = 'ots' and a.status = 'confirmed'
           and a.tree_size > c.log_index
         order by a.tree_size limit 1),
        (select a.tree_size from public_panel.timestamp_anchors a
         where a.origin = ${origin} and a.kind = 'ots' and a.status = 'pending'
           and a.tree_size > c.log_index
         order by a.tree_size limit 1),
        (select f.tree_size from public_panel.evidence_batches f
         where f.origin = ${origin} and f.published_at is not null and f.tree_size > c.log_index
         order by f.tree_size limit 1)) as tree_size
    ) pick on true
    left join public_panel.evidence_batches b
      on b.origin = ${origin} and b.tree_size = pick.tree_size
    left join lateral (
      select tree_size, checkpoint_note from public_panel.evidence_batches
      where origin = ${origin} and published_at is not null
      order by tree_size desc limit 1
    ) l on b.tree_size is not null
    left join public_panel.timestamp_anchors o
      on o.origin = b.origin and o.tree_size = b.tree_size and o.kind = 'ots'
        and o.status in ('pending', 'confirmed')
    left join lateral (
      select array_agg(a.provider order by a.provider) as providers,
        array_agg(a.proof order by a.provider) as proofs
      from public_panel.timestamp_anchors a
      where a.origin = b.origin and a.tree_size = b.tree_size and a.kind = 'rfc3161'
        and a.status = 'confirmed'
    ) t on true
    where c.id = ${captureId}`;
}

/**
 * Each capture's save time, whether a published checkpoint holds it, and the Bitcoin time of the
 * first confirmed checkpoint that does, in input order.
 */
export function sealSummariesQuery(captureIds: readonly CaptureId[], origin: string): SQL {
  return sql`
    select v.id, c.captured_at, f.logged, d.attested_at
    from unnest(${sql.param(captureIds)}::text[]) with ordinality as v(id, ord)
    join public_panel.captures c on c.id = v.id
    left join lateral (
      select true as logged from public_panel.evidence_batches b
      where b.origin = ${origin} and b.published_at is not null and b.tree_size > c.log_index
      order by b.tree_size limit 1
    ) f on true
    left join lateral (
      select a.attested_at from public_panel.timestamp_anchors a
      where a.origin = ${origin} and a.kind = 'ots' and a.status = 'confirmed'
        and a.tree_size > c.log_index
      order by a.tree_size limit 1
    ) d on true
    order by v.ord`;
}

/** Removal records of the given digests, keyed by hex digest. */
async function removalsOf(digests: string[]): Promise<Map<string, Removal>> {
  const { rows } = await withSystem(
    "evidence.bundle",
    (tx) =>
      tx.execute<{ sha256: Buffer } & Removal>(sql`
        select r.sha256, r.removed_at, r.reason
        from unnest(${sql.param(digests)}::text[]) as d(sha256)
        join public_panel.artifact_removals r on r.sha256 = decode(d.sha256, 'hex')`),
    { readOnly: true },
  );
  return new Map(rows.map((row) => [toHex(row.sha256), row]));
}

function artifact(sha256: string, removals: Map<string, Removal>): BundleArtifact {
  const removal = removals.get(sha256);
  if (!removal) return { sha256, status: "available" };
  return {
    sha256,
    status: "removed",
    removed_at: removal.removed_at.toISOString(),
    reason: removal.reason,
  };
}

/**
 * Everything a third party needs to verify a capture offline: its envelope, artifact digests,
 * inclusion in a published checkpoint, consistency with the latest one, and that checkpoint's
 * timestamps. Null for an unknown capture and for one no published checkpoint holds yet.
 */
export async function buildBundle(captureId: CaptureId): Promise<EvidenceBundleV1 | null> {
  const origin = logOrigin();
  const {
    rows: [row],
  } = await withSystem(
    "evidence.bundle",
    (tx) => tx.execute<BundleRow>(bundleQuery(captureId, origin)),
    { readOnly: true },
  );
  if (!row?.tree_size || !row.checkpoint_note || !row.latest_size || !row.latest_note) return null;
  const index = Number(row.log_index);
  const treeSize = Number(row.tree_size);
  const latestSize = Number(row.latest_size);
  const normalizedSha256 = row.normalized_sha256 ? toHex(row.normalized_sha256) : null;

  // The raw digest is only in the signed statement, so its removal is looked up after the
  // envelope arrives, while the proofs are read from the tiles.
  const signed = readStatement(toHex(row.envelope_sha256)).then(async ({ envelope, statement }) => {
    const rawSha256 = subjectDigest(statement, "raw");
    const digests = normalizedSha256 ? [rawSha256, normalizedSha256] : [rawSha256];
    return { envelope, rawSha256, removals: await removalsOf(digests) };
  });
  const [{ envelope, rawSha256, removals }, inclusion, consistency] = await Promise.all([
    signed,
    proveRecord(treeSize, index, readHashes(origin, treeSize)),
    proveTree(latestSize, treeSize, readHashes(origin, latestSize)),
  ]);

  const tsrProofs = row.tsr_proofs ?? [];
  return {
    version: 1,
    capture_id: captureId,
    envelope,
    artifacts: {
      raw: artifact(rawSha256, removals),
      ...(normalizedSha256 ? { normalized: artifact(normalizedSha256, removals) } : {}),
    },
    inclusion: { log: origin, index, tree_size: treeSize, hashes: inclusion.map(toBase64) },
    checkpoint: row.checkpoint_note,
    latest: { checkpoint: row.latest_note, consistency: consistency.map(toBase64) },
    anchors: {
      ots:
        row.ots_status && row.ots_proof
          ? {
              status: row.ots_status,
              proof: toBase64(row.ots_proof),
              bitcoin_height: row.bitcoin_height,
            }
          : null,
      tsr: (row.tsr_providers ?? []).map((provider, i) => ({
        provider,
        proof: toBase64(tsrProofs[i] as Buffer),
      })),
    },
    rekor: null,
    plan: null,
    tlsn: null,
  };
}

/**
 * The seal state of each capture for reports and emails, in one query: input order, unknown ids
 * dropped. A capture is dated by the first confirmed checkpoint that holds it.
 */
export async function getSealSummaries(captureIds: readonly CaptureId[]): Promise<SealSummary[]> {
  if (captureIds.length === 0) return [];
  const origin = logOrigin();
  const { rows } = await withSystem(
    "evidence.seal_summaries",
    (tx) => tx.execute<SummaryRow>(sealSummariesQuery(captureIds, origin)),
    { readOnly: true },
  );
  return rows.map((row) => ({
    captureId: row.id,
    savedAt: row.captured_at,
    status: row.attested_at ? "dated" : row.logged ? "logged" : "signed",
    datedBefore: row.attested_at,
    verifyUrl: verifyUrl(row.id),
  }));
}
