import { withSystem } from "@reranker/db";
import { extractions, mentions } from "@reranker/db/schema";
import { AppError, type ProviderCost } from "@reranker/schema";
import type {
  Agreement,
  AnswerKind,
  EntityKey,
  EntityKind,
  ResolutionMethod,
  ResolutionStatus,
  Sentiment,
  Stance,
} from "@reranker/schema/measurement";
import { and, asc, eq, gt, gte, inArray } from "drizzle-orm";

const REASON = "extraction.store";

export type ExtractionRow = {
  captureId: string;
  /** Hex SHA-256 digests. */
  configHash: string;
  outputsSha256: string;
  answerKind: AnswerKind;
  agreement: Agreement;
  judgeUsed: boolean;
  inputTokens: number;
  outputTokens: number;
  cost: ProviderCost;
  latencyMs: number;
  disputedCount: number;
};

export type MentionRow = {
  extractionId: string;
  entityKey: EntityKey;
  entityKind: EntityKind;
  stance: Stance;
  sentiment: Sentiment;
  ordinal: number | null;
  startOffset: number;
  endOffset: number;
  /** Null for professionals, whose name is kept only as its HMAC. */
  nameNorm: string | null;
  /** Hex HMAC-SHA-256 of the normalized name. */
  nameHmac: string;
  placeId: string | null;
  resolutionStatus: ResolutionStatus;
  resolutionMethod: ResolutionMethod;
  resolutionScore: number | null;
  isTarget: boolean;
  /** Hex SHA-256 digests of the cited URLs. */
  citedUrlHashes: string[];
};

const bytes = (hex: string) => Buffer.from(hex, "hex");

/**
 * Stores an extraction once per capture and config. A retried or concurrent write gets the row
 * already stored, so the caller can tell it must not pay for the extraction again.
 */
export async function insertExtraction(
  row: ExtractionRow,
): Promise<{ id: string; inserted: boolean }> {
  const captureId = row.captureId;
  const configHash = bytes(row.configHash);
  return withSystem(REASON, async (tx) => {
    const [created] = await tx
      .insert(extractions)
      .values({
        captureId,
        configHash,
        outputsSha256: bytes(row.outputsSha256),
        answerKind: row.answerKind,
        agreement: row.agreement,
        judgeUsed: row.judgeUsed,
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
        cost_amount_micros: row.cost.amount_micros,
        cost_currency: row.cost.currency,
        latencyMs: row.latencyMs,
        disputedCount: row.disputedCount,
      })
      .onConflictDoNothing({ target: [extractions.captureId, extractions.configHash] })
      .returning({ id: extractions.id });
    if (created) return { id: created.id, inserted: true };
    // A new statement under read committed sees the row the concurrent writer committed.
    const [existing] = await tx
      .select({ id: extractions.id })
      .from(extractions)
      .where(and(eq(extractions.captureId, captureId), eq(extractions.configHash, configHash)));
    if (!existing) {
      throw new AppError("internal", {
        detail: `extraction of ${captureId} vanished after a conflict`,
      });
    }
    return { id: existing.id, inserted: false };
  });
}

export async function findExtraction(
  captureId: string,
  configHash: string,
): Promise<{ id: string; outputsSha256: string } | null> {
  const [row] = await withSystem(REASON, (tx) =>
    tx
      .select({ id: extractions.id, outputsSha256: extractions.outputsSha256 })
      .from(extractions)
      .where(
        and(eq(extractions.captureId, captureId), eq(extractions.configHash, bytes(configHash))),
      ),
  );
  return row ? { id: row.id, outputsSha256: row.outputsSha256.toString("hex") } : null;
}

/** The stored extraction id of each capture under one config, in one query. */
export async function extractionIdsOf(
  captureIds: string[],
  configHash: string,
): Promise<Map<string, string>> {
  if (captureIds.length === 0) return new Map();
  const rows = await withSystem(REASON, (tx) =>
    tx
      .select({ id: extractions.id, captureId: extractions.captureId })
      .from(extractions)
      .where(
        and(
          inArray(extractions.captureId, captureIds),
          eq(extractions.configHash, bytes(configHash)),
        ),
      ),
  );
  return new Map(rows.map((row) => [row.captureId, row.id]));
}

/** Writes a report's mentions in one statement; rows already stored are skipped. */
export async function insertMentions(rows: MentionRow[]): Promise<number> {
  if (rows.length === 0) return 0;
  const result = await withSystem(REASON, (tx) =>
    tx
      .insert(mentions)
      .values(
        rows.map((row) => ({
          extractionId: row.extractionId,
          entityKey: row.entityKey,
          entityKind: row.entityKind,
          stance: row.stance,
          sentiment: row.sentiment,
          ordinal: row.ordinal,
          startOffset: row.startOffset,
          endOffset: row.endOffset,
          nameNorm: row.nameNorm,
          nameHmac: bytes(row.nameHmac),
          placeId: row.placeId,
          resolutionStatus: row.resolutionStatus,
          resolutionMethod: row.resolutionMethod,
          resolutionScore: row.resolutionScore,
          isTarget: row.isTarget,
          citedUrlHashes: Buffer.concat(row.citedUrlHashes.map(bytes)),
        })),
      )
      .onConflictDoNothing(),
  );
  return result.rowCount ?? 0;
}

/** Extractions whose extractors disagreed, oldest first: the review queue of the gold set. */
export async function listDisagreements(
  since: Date,
  limit: number,
): Promise<Array<{ captureId: string; outputsSha256: string; disputedCount: number }>> {
  const rows = await withSystem(REASON, (tx) =>
    tx
      .select({
        captureId: extractions.captureId,
        outputsSha256: extractions.outputsSha256,
        disputedCount: extractions.disputedCount,
      })
      .from(extractions)
      .where(and(gt(extractions.disputedCount, 0), gte(extractions.createdAt, since)))
      .orderBy(asc(extractions.createdAt))
      .limit(limit),
  );
  return rows.map((row) => ({ ...row, outputsSha256: row.outputsSha256.toString("hex") }));
}
