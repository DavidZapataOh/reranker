import { CaptureChannel, CaptureProvider, EngineId } from "@reranker/schema";
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { bytea } from "./_columns";
import { costMicrosColumn } from "./_money";
import { publicPanelSchema } from "./_schemas";
import { sharedTable } from "./_tables";

const at = () => timestamp({ withTimezone: true });

// drizzle-kit drops the schema of an enum built from an object, so the values go in as a tuple;
// a zod enum always has at least one option.
const values = <T extends string>(zodEnum: { options: T[] }) => zodEnum.options as [T, ...T[]];

export const captureEngine = publicPanelSchema.enum("capture_engine", values(EngineId));
export const captureChannel = publicPanelSchema.enum("capture_channel", values(CaptureChannel));
export const captureProvider = publicPanelSchema.enum("capture_provider", values(CaptureProvider));
export const captureMode = publicPanelSchema.enum("capture_mode", ["live", "task"]);
export const captureStatus = publicPanelSchema.enum("capture_status", [
  "succeeded",
  "provider_error",
  "timeout",
]);

/** One measurement; its id is the measurementId and its slots live in the sealed plan artifact. */
export const measurementPlans = sharedTable(
  "measurement_plans",
  {
    // The spend purposes of @reranker/jobs, which depends on this package.
    purpose: text().notNull(),
    refType: text().notNull(),
    refId: text().notNull(),
    digest: bytea().notNull(),
    planEnvelopeSha256: bytea(),
    slotCount: smallint().notNull(),
    createdAt: at().notNull().defaultNow(),
    frozenAt: at(),
  },
  (t) => [
    index("measurement_plans_ref_type_ref_id_idx").on(t.refType, t.refId),
    check(
      "measurement_plans_purpose_check",
      sql`${t.purpose} in ('free-report', 'control-canary', 'quality-canary', 'benchmark', 'contract-test')`,
    ),
    check("measurement_plans_digest_length", sql`octet_length(${t.digest}) = 32`),
    check(
      "measurement_plans_plan_envelope_sha256_length",
      sql`octet_length(${t.planEnvelopeSha256}) = 32`,
    ),
  ],
);

const cost = costMicrosColumn("cost");

/**
 * One provider call for one slot. The id is cap_ + ULID, the capture_id of its signed statement;
 * the raw bytes live in the evidence artifacts, and the row keeps only their digests.
 */
export const captures = publicPanelSchema.table(
  "captures",
  // Postgres stores columns in declaration order and pads each to its alignment, so they go from
  // widest alignment to narrowest, variable-length last: no padding inside the row.
  {
    capturedAt: at().notNull().defaultNow(),
    cost_amount_micros: cost.cost_amount_micros,
    logIndex: bigint({ mode: "number" }),
    measurementId: uuid()
      .notNull()
      .references(() => measurementPlans.id),
    engine: captureEngine().notNull(),
    channel: captureChannel().notNull(),
    provider: captureProvider().notNull(),
    mode: captureMode().notNull(),
    status: captureStatus().notNull(),
    providerStatusCode: integer(),
    responseBytes: integer().notNull(),
    latencyMs: integer().notNull(),
    slotIndex: smallint().notNull(),
    attempt: smallint().notNull(),
    httpStatus: smallint(),
    parserVersion: smallint(),
    late: boolean().notNull().default(false),
    id: text().primaryKey(),
    cost_currency: cost.cost_currency,
    intentSetId: text().notNull(),
    intentId: text().notNull(),
    modelReported: text(),
    envelopeSha256: bytea().notNull(),
    // The digest of the original parse; re-derivations are entries of the evidence log.
    normalizedSha256: bytea(),
  },
  (t) => [
    uniqueIndex("captures_one_success")
      .on(t.measurementId, t.slotIndex)
      .where(sql`${t.status} = 'succeeded'`),
    unique("captures_log_index_key").on(t.logIndex),
    // The queue of captures not yet appended to the transparency log.
    index("captures_pending_log_idx").on(t.envelopeSha256).where(sql`${t.logIndex} is null`),
    index("captures_intent_set_id_intent_id_engine_idx").on(t.intentSetId, t.intentId, t.engine),
    index("captures_engine_captured_at_idx").on(t.engine, t.capturedAt.desc()),
    check("captures_id_check", sql`${t.id} ~ '^cap_[0-9A-HJKMNP-TV-Z]{26}$'`),
    check("captures_envelope_sha256_length", sql`octet_length(${t.envelopeSha256}) = 32`),
    check("captures_normalized_sha256_length", sql`octet_length(${t.normalizedSha256}) = 32`),
  ],
);
