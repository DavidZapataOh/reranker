import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import { bytea, timestamps } from "./_columns";
import { publicPanelSchema } from "./_schemas";
import { sharedTable } from "./_tables";

const at = () => timestamp({ withTimezone: true });

// Captures carry their log entry in public_panel.captures; every other signed statement waits here.
export const evidenceEntryKind = publicPanelSchema.enum("evidence_entry_kind", [
  "plan",
  "reparse",
  "consent",
  "key",
  "regime",
  "extraction",
]);

/**
 * Signed statements other than captures, queued for the transparency log. The natural key names
 * the statement, so the table carries no surrogate id; log_index is set once, on integration.
 */
export const evidenceEntries = publicPanelSchema.table(
  "evidence_entries",
  // Widest alignment first and variable-length last, so Postgres adds no padding inside the row.
  {
    logIndex: bigint({ mode: "number" }),
    signedAt: at().notNull().defaultNow(),
    kind: evidenceEntryKind().notNull(),
    revision: smallint().notNull().default(0),
    ref: text().notNull(),
    envelopeSha256: bytea().notNull(),
    normalizedSha256: bytea(),
  },
  (t) => [
    primaryKey({ columns: [t.ref, t.kind, t.revision] }),
    unique("evidence_entries_log_index_key").on(t.logIndex),
    // The queue of entries not yet appended to the transparency log, read in envelope order.
    index("evidence_entries_pending_log_idx")
      .on(t.envelopeSha256)
      .where(sql`${t.logIndex} is null`),
    check("evidence_entries_revision_check", sql`${t.revision} >= 0`),
    check("evidence_entries_envelope_sha256_length", sql`octet_length(${t.envelopeSha256}) = 32`),
    check(
      "evidence_entries_normalized_sha256_length",
      sql`octet_length(${t.normalizedSha256}) = 32`,
    ),
  ],
);

/** One integration of the log: the signed checkpoint and the frontier the next batch extends. */
export const evidenceBatches = publicPanelSchema.table(
  "evidence_batches",
  {
    treeSize: bigint({ mode: "number" }).notNull(),
    firstIndex: bigint({ mode: "number" }).notNull(),
    createdAt: at().notNull().defaultNow(),
    publishedAt: at(),
    origin: text().notNull(),
    root: bytea().notNull(),
    // Right-edge subtree roots, one per set bit of tree_size.
    frontier: bytea().notNull(),
    checkpointNote: text().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.origin, t.treeSize] }),
    check(
      "evidence_batches_indexes_check",
      sql`${t.firstIndex} >= 0 and ${t.firstIndex} < ${t.treeSize}`,
    ),
    check("evidence_batches_root_length", sql`octet_length(${t.root}) = 32`),
    check(
      "evidence_batches_frontier_length",
      sql`octet_length(${t.frontier}) % 32 = 0 and octet_length(${t.frontier}) between 32 and 2048`,
    ),
  ],
);

/** OpenTimestamps and RFC 3161 proofs of a checkpoint; retried until confirmed or failed. */
export const timestampAnchors = sharedTable(
  "timestamp_anchors",
  {
    treeSize: bigint({ mode: "number" }).notNull(),
    attestedAt: at(),
    nextAttemptAt: at().notNull().defaultNow(),
    ...timestamps(),
    bitcoinHeight: integer(),
    attempts: integer().notNull().default(0),
    origin: text().notNull(),
    kind: text().notNull(),
    provider: text().notNull(),
    status: text().notNull().default("pending"),
    proof: bytea(),
  },
  (t) => [
    foreignKey({
      name: "timestamp_anchors_batch_fk",
      columns: [t.origin, t.treeSize],
      foreignColumns: [evidenceBatches.origin, evidenceBatches.treeSize],
    }),
    unique("timestamp_anchors_batch_kind_provider_key").on(
      t.origin,
      t.treeSize,
      t.kind,
      t.provider,
    ),
    index("timestamp_anchors_status_next_attempt_at_idx").on(t.status, t.nextAttemptAt),
    index("timestamp_anchors_confirmed_ots_idx")
      .on(t.origin, t.treeSize)
      .where(sql`${t.kind} = 'ots' and ${t.status} = 'confirmed'`),
    check(
      "timestamp_anchors_provider_check",
      sql`(${t.kind} = 'ots' and ${t.provider} = 'ots-calendars') or (${t.kind} = 'rfc3161' and ${t.provider} in ('qtsa', 'digicert'))`,
    ),
    check("timestamp_anchors_status_check", sql`${t.status} in ('pending', 'confirmed', 'failed')`),
    // python-opentimestamps refuses calendar answers over 10,000 bytes; a TSA token is far smaller.
    check("timestamp_anchors_proof_length", sql`octet_length(${t.proof}) <= 10240`),
    check("timestamp_anchors_attempts_check", sql`${t.attempts} >= 0`),
  ],
);

/** Public keys that ever signed evidence, so a verifier can judge a signature at its time. */
export const signingKeys = publicPanelSchema.table(
  "signing_keys",
  {
    validFrom: at().notNull(),
    validTo: at(),
    compromisedAfter: at(),
    keyid: text().primaryKey(),
    purpose: text().notNull(),
    env: text().notNull(),
    publicKey: bytea().notNull(),
    custody: text().notNull(),
    // c2sp.org/signed-note verifier key, only for log keys.
    noteVkey: text(),
  },
  (t) => [
    check("signing_keys_purpose_check", sql`${t.purpose} in ('capture', 'log')`),
    check("signing_keys_env_check", sql`${t.env} in ('production', 'preview')`),
    check("signing_keys_custody_check", sql`${t.custody} in ('aws-kms-hsm', 'gcp-kms-software')`),
    check("signing_keys_public_key_length", sql`octet_length(${t.publicKey}) = 32`),
    check(
      "signing_keys_validity_check",
      sql`${t.validTo} is null or ${t.validTo} > ${t.validFrom}`,
    ),
  ],
);

/** Artifacts taken down from public storage; the signed digests stay and keep verifying. */
export const artifactRemovals = publicPanelSchema.table(
  "artifact_removals",
  {
    removedAt: at().notNull().defaultNow(),
    sha256: bytea().primaryKey(),
    kind: text().notNull(),
    reason: text().notNull(),
  },
  (t) => [
    check("artifact_removals_sha256_length", sql`octet_length(${t.sha256}) = 32`),
    check(
      "artifact_removals_kind_check",
      sql`${t.kind} in ('raw', 'request', 'normalized', 'plans', 'envelopes', 'intent-sets', 'extractions')`,
    ),
    check(
      "artifact_removals_reason_check",
      sql`${t.reason} in ('personal_data_request', 'legal_order')`,
    ),
  ],
);
