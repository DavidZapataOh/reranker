import { withSystem } from "@reranker/db";
import { evidenceBatches, timestampAnchors } from "@reranker/db/schema";
import { log } from "@reranker/telemetry";
import {
  bitcoinAttestations,
  parseDetachedOts,
  serializeDetachedOts,
} from "@reranker/verify/format";
import { and, asc, count, desc, eq, isNotNull, lt, lte } from "drizzle-orm";
import { checkpointDigest } from "../log/checkpoint";
import { BlockHeaderUnavailableError, blockHeader } from "./bitcoin";
import { submitDigest, upgradeTimestamp } from "./ots";
import { requestTimestamp, TSAS, type TsaName } from "./rfc3161";

type TsaOutcome = "confirmed" | "failed" | "skipped";
export type AnchorResult =
  | { treeSize: null }
  | { treeSize: number; ots: "pending" | "failed"; tsa: Record<TsaName, TsaOutcome> };

const OTS_PROVIDER = "ots-calendars";
const TSA_NAMES = Object.keys(TSAS) as TsaName[];
// Each run handles a bounded slice so it ends well inside a step; anchors are hourly, so a
// backlog this deep means calendars have been down for a day.
const UPGRADE_BATCH = 24;
const FIRST_RETRY_MS = 15 * 60_000;
const MAX_RETRY_MS = 2 * 60 * 60_000;
// Calendars commit to Bitcoin within hours; a day without a block means something broke.
const OVERDUE_MS = 24 * 60 * 60_000;

/**
 * Timestamps the newest published checkpoint of `origin` in OpenTimestamps and every configured
 * RFC 3161 TSA, once: a checkpoint with an OpenTimestamps proof is never anchored again. Each
 * service answers on its own, so a TSA failure never costs the others their proof, and a failed
 * OpenTimestamps submission leaves the checkpoint for the next hour.
 */
export async function anchorLatest(origin: string): Promise<AnchorResult> {
  const latest = await withSystem("evidence.anchor", async (tx) => {
    const [batch] = await tx
      .select({ treeSize: evidenceBatches.treeSize, note: evidenceBatches.checkpointNote })
      .from(evidenceBatches)
      .where(and(eq(evidenceBatches.origin, origin), isNotNull(evidenceBatches.publishedAt)))
      .orderBy(desc(evidenceBatches.treeSize))
      .limit(1);
    if (!batch) return null;
    const anchors = await tx
      .select({ provider: timestampAnchors.provider })
      .from(timestampAnchors)
      .where(
        and(eq(timestampAnchors.origin, origin), eq(timestampAnchors.treeSize, batch.treeSize)),
      );
    return { ...batch, done: new Set(anchors.map((a) => a.provider)) };
  });
  if (!latest || latest.done.has(OTS_PROVIDER)) return { treeSize: null };

  const digest = checkpointDigest(latest.note);
  // A TSA already holding a token for this checkpoint is not asked again: qtsa.eu stamps are paid.
  const tsas = TSA_NAMES.map((name) => ({ name, url: TSAS[name].url() })).filter(
    ({ name, url }) => url !== null && !latest.done.has(name),
  ) as Array<{ name: TsaName; url: string }>;
  const [ots, ...stamps] = await Promise.allSettled([
    submitDigest(digest),
    ...tsas.map(({ url }) => requestTimestamp(url, digest)),
  ]);

  const rows: Array<typeof timestampAnchors.$inferInsert> = [];
  const base = { origin, treeSize: latest.treeSize };
  if (ots?.status === "fulfilled") {
    const proof = Buffer.from(serializeDetachedOts(digest, ots.value.timestamp));
    rows.push({ ...base, kind: "ots", provider: OTS_PROVIDER, status: "pending", proof });
  } else {
    log.warn("evidence.anchor.ots_failed", { origin, tree_size: latest.treeSize });
  }
  const tsa = Object.fromEntries(TSA_NAMES.map((name) => [name, "skipped"])) as Record<
    TsaName,
    TsaOutcome
  >;
  stamps.forEach((stamp, i) => {
    const { name } = tsas[i] as { name: TsaName };
    const confirmed = stamp.status === "fulfilled";
    tsa[name] = confirmed ? "confirmed" : "failed";
    rows.push({
      ...base,
      kind: "rfc3161",
      provider: name,
      status: tsa[name],
      proof: confirmed ? Buffer.from(stamp.value) : null,
    });
    if (!confirmed) {
      log.warn("evidence.anchor.tsa_failed", {
        origin,
        tree_size: latest.treeSize,
        tsa: name,
        error: stamp.reason instanceof Error ? stamp.reason.message : String(stamp.reason),
      });
    }
  });
  if (rows.length > 0) {
    // A retried step finds its own rows already there and keeps them.
    await withSystem("evidence.anchor", (tx) =>
      tx.insert(timestampAnchors).values(rows).onConflictDoNothing(),
    );
  }
  return {
    treeSize: latest.treeSize,
    ots: ots?.status === "fulfilled" ? "pending" : "failed",
    tsa,
  };
}

type Pending = { id: string; proof: Buffer; attempts: number };
type Upgrade =
  | { status: "confirmed"; proof: Buffer; height: number; time: Date }
  | { status: "pending"; proof: Buffer | null }
  | { status: "failed"; proof: Buffer };

/** Confirms a proof only against a block header the explorers agree on. */
async function upgradeOne(row: Pending): Promise<Upgrade> {
  const { digest, timestamp } = parseDetachedOts(row.proof);
  const { upgraded } = await upgradeTimestamp(timestamp);
  const proof = upgraded ? Buffer.from(serializeDetachedOts(digest, timestamp)) : null;
  const attestations = bitcoinAttestations(timestamp).sort((a, b) => a.height - b.height);
  if (attestations.length === 0) return { status: "pending", proof };
  for (const { height, commitment } of attestations) {
    try {
      const header = await blockHeader(height);
      if (header.merkleRoot === commitment) {
        return { status: "confirmed", proof: proof ?? row.proof, height, time: header.time };
      }
    } catch (error) {
      if (error instanceof BlockHeaderUnavailableError) return { status: "pending", proof };
      throw error;
    }
  }
  // Every claimed block exists and none carries the commitment: the calendar answer is no proof.
  log.error("evidence.ots.attestation_mismatch", { id: row.id });
  return { status: "failed", proof: proof ?? row.proof };
}

/**
 * Asks the calendars about every OpenTimestamps proof still waiting for Bitcoin and due for a
 * retry. A confirmed proof records its block height and time; one still pending retries after
 * 15 minutes, doubling up to 2 hours. Proofs pending for over a day are counted as overdue.
 */
export async function upgradePendingOts(
  now: Date = new Date(),
): Promise<{ checked: number; confirmed: number; overdue: number }> {
  const { due, overdue } = await withSystem("evidence.ots_upgrade", async (tx) => {
    const pendingOts = and(
      eq(timestampAnchors.kind, "ots"),
      eq(timestampAnchors.status, "pending"),
      isNotNull(timestampAnchors.proof),
    );
    const rows = await tx
      .select({
        id: timestampAnchors.id,
        proof: timestampAnchors.proof,
        attempts: timestampAnchors.attempts,
      })
      .from(timestampAnchors)
      .where(and(pendingOts, lte(timestampAnchors.nextAttemptAt, now)))
      .orderBy(asc(timestampAnchors.nextAttemptAt))
      .limit(UPGRADE_BATCH);
    const [late] = await tx
      .select({ n: count() })
      .from(timestampAnchors)
      .where(and(pendingOts, lt(timestampAnchors.createdAt, new Date(now.getTime() - OVERDUE_MS))));
    return { due: rows as Pending[], overdue: late?.n ?? 0 };
  });

  // One unreadable proof backs off on its own instead of holding back every other upgrade.
  const results = await Promise.all(
    due.map((row) =>
      upgradeOne(row).catch((error: unknown): Upgrade => {
        log.error("evidence.ots.upgrade_failed", {
          id: row.id,
          error: error instanceof Error ? error.message : String(error),
        });
        return { status: "pending", proof: null };
      }),
    ),
  );
  let confirmed = 0;
  await withSystem("evidence.ots_upgrade", async (tx) => {
    for (const [i, result] of results.entries()) {
      const row = due[i] as Pending;
      const attempts = row.attempts + 1;
      const set: Partial<typeof timestampAnchors.$inferInsert> = { attempts };
      if (result.proof) set.proof = result.proof;
      if (result.status === "confirmed") {
        confirmed++;
        Object.assign(set, {
          status: "confirmed",
          bitcoinHeight: result.height,
          attestedAt: result.time,
        });
      } else if (result.status === "failed") {
        set.status = "failed";
      } else {
        const wait = Math.min(FIRST_RETRY_MS * 2 ** (attempts - 1), MAX_RETRY_MS);
        set.nextAttemptAt = new Date(now.getTime() + wait);
      }
      await tx.update(timestampAnchors).set(set).where(eq(timestampAnchors.id, row.id));
    }
  });
  if (overdue > 0) log.warn("evidence.ots.overdue", { overdue });
  return { checked: due.length, confirmed, overdue };
}
