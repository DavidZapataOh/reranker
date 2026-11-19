import {
  Agreement,
  AnswerKind,
  EntityKind,
  ResolutionMethod,
  ResolutionStatus,
  Sentiment,
  Stance,
} from "@reranker/schema/measurement";
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  primaryKey,
  real,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { bytea, enumValues } from "./_columns";
import { costMicrosColumn } from "./_money";
import { publicPanelSchema } from "./_schemas";
import { sharedTable } from "./_tables";
import { captures } from "./capture";

const at = () => timestamp({ withTimezone: true });
const sha256 = (table: string, column: string) =>
  check(`${table}_${column}_length`, sql`octet_length(${sql.identifier(column)}) = 32`);

export const answerKind = publicPanelSchema.enum("answer_kind", enumValues(AnswerKind));
export const agreement = publicPanelSchema.enum("agreement", enumValues(Agreement));
export const entityKind = publicPanelSchema.enum("entity_kind", enumValues(EntityKind));
export const stance = publicPanelSchema.enum("stance", enumValues(Stance));
export const sentiment = publicPanelSchema.enum("sentiment", enumValues(Sentiment));
export const resolutionStatus = publicPanelSchema.enum(
  "resolution_status",
  enumValues(ResolutionStatus),
);
export const resolutionMethod = publicPanelSchema.enum(
  "resolution_method",
  enumValues(ResolutionMethod),
);
export const placesOutcome = publicPanelSchema.enum("places_outcome", [
  "place",
  "chain",
  "unresolvable",
]);

const cost = costMicrosColumn("cost");

/**
 * One extractor run over one capture. The extractor and judge outputs live in the artifact
 * extractions/<outputs_sha256>; disagreements are rebuilt from it, so only their count stays here.
 */
export const extractions = sharedTable(
  "extractions",
  // Widest alignment first and variable-length last, so Postgres adds no padding inside the row.
  {
    createdAt: at().notNull().defaultNow(),
    cost_amount_micros: cost.cost_amount_micros,
    inputTokens: integer().notNull(),
    outputTokens: integer().notNull(),
    latencyMs: integer().notNull(),
    answerKind: answerKind().notNull(),
    agreement: agreement().notNull(),
    disputedCount: smallint().notNull().default(0),
    judgeUsed: boolean().notNull(),
    captureId: text()
      .notNull()
      .references(() => captures.id),
    cost_currency: cost.cost_currency,
    configHash: bytea().notNull(),
    outputsSha256: bytea().notNull(),
  },
  (t) => [
    unique("extractions_capture_id_config_hash_key").on(t.captureId, t.configHash),
    // The review queue of disagreements for the gold set.
    index("extractions_disputed_created_at_idx").on(t.createdAt).where(sql`${t.disputedCount} > 0`),
    sha256("extractions", "config_hash"),
    sha256("extractions", "outputs_sha256"),
    check(
      "extractions_counts_check",
      sql`${t.inputTokens} >= 0 and ${t.outputTokens} >= 0 and ${t.latencyMs} >= 0 and ${t.disputedCount} >= 0`,
    ),
  ],
);

/**
 * The mentions a report uses. The visible name is read from the stored answer with the offsets;
 * a professional (a natural person) keeps only the keyed hash of the name, never the name.
 */
export const mentions = publicPanelSchema.table(
  "mentions",
  {
    extractionId: uuid()
      .notNull()
      .references(() => extractions.id, { onDelete: "cascade" }),
    startOffset: integer().notNull(),
    endOffset: integer().notNull(),
    resolutionScore: real(),
    entityKind: entityKind().notNull(),
    stance: stance().notNull(),
    sentiment: sentiment().notNull(),
    resolutionStatus: resolutionStatus().notNull(),
    resolutionMethod: resolutionMethod().notNull(),
    ordinal: smallint(),
    isTarget: boolean().notNull(),
    entityKey: text().notNull(),
    nameHmac: bytea().notNull(),
    // SHA-256 digests of the cited URLs, concatenated: one value instead of an array of them.
    citedUrlHashes: bytea().notNull().default(sql`'\\x'::bytea`),
    nameNorm: text(),
    placeId: text(),
  },
  (t) => [
    // Two mentions of one extraction never start at the same offset, so a retried write is a no-op.
    primaryKey({ columns: [t.extractionId, t.startOffset] }),
    index("mentions_entity_key_idx").on(t.entityKey),
    sha256("mentions", "name_hmac"),
    check(
      "mentions_cited_url_hashes_length",
      sql`octet_length(${t.citedUrlHashes}) % 32 = 0 and octet_length(${t.citedUrlHashes}) <= 2048`,
    ),
    check(
      "mentions_offsets_check",
      sql`${t.startOffset} >= 0 and ${t.endOffset} > ${t.startOffset}`,
    ),
    check(
      "mentions_ordinal_check",
      sql`${t.ordinal} is null or (${t.ordinal} >= 1 and ${t.stance} = 'recommendation')`,
    ),
    check(
      "mentions_resolution_score_check",
      sql`${t.resolutionScore} >= 0 and ${t.resolutionScore} <= 1`,
    ),
    check(
      "mentions_professional_name_check",
      sql`${t.entityKind} <> 'professional' or ${t.nameNorm} is null`,
    ),
  ],
);

/**
 * Cached resolution decisions. Only the place_id, which Google lets us keep indefinitely, and our
 * own decision are stored; no Places content.
 */
export const places = publicPanelSchema.table(
  "places",
  {
    decidedAt: at().notNull().defaultNow(),
    validatedAt: at().notNull().defaultNow(),
    score: real(),
    outcome: placesOutcome().notNull(),
    method: resolutionMethod().notNull(),
    nameHmac: bytea().notNull(),
    configHash: bytea().notNull(),
    geoKey: text().notNull(),
    categoryKey: text().notNull(),
    placeId: text(),
  },
  (t) => [
    primaryKey({ columns: [t.nameHmac, t.geoKey, t.categoryKey, t.configHash] }),
    // The daily refresh reads the place ids that were validated longest ago.
    index("places_place_validated_at_idx").on(t.validatedAt).where(sql`${t.outcome} = 'place'`),
    sha256("places", "name_hmac"),
    sha256("places", "config_hash"),
    check("places_place_id_check", sql`(${t.outcome} = 'place') = (${t.placeId} is not null)`),
    check("places_score_check", sql`${t.score} >= 0 and ${t.score} <= 1`),
  ],
);
