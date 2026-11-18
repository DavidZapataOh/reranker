-- Revisions of one statement, retry attempts and Bitcoin block heights stay far below 2^31, and
-- the narrow types keep the per-report evidence rows small.
-- squawk-ignore-file prefer-bigint-over-smallint, prefer-bigint-over-int
CREATE TYPE "public_panel"."evidence_entry_kind" AS ENUM('plan', 'reparse', 'consent', 'key', 'regime', 'extraction');--> statement-breakpoint
CREATE TABLE "public_panel"."artifact_removals" (
	"removed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sha256" "bytea" PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"reason" text NOT NULL,
	CONSTRAINT "artifact_removals_sha256_length" CHECK (octet_length("public_panel"."artifact_removals"."sha256") = 32),
	CONSTRAINT "artifact_removals_kind_check" CHECK ("public_panel"."artifact_removals"."kind" in ('raw', 'request', 'normalized', 'plans', 'envelopes', 'intent-sets', 'extractions')),
	CONSTRAINT "artifact_removals_reason_check" CHECK ("public_panel"."artifact_removals"."reason" in ('personal_data_request', 'legal_order'))
);
--> statement-breakpoint
CREATE TABLE "public_panel"."evidence_batches" (
	"tree_size" bigint NOT NULL,
	"first_index" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone,
	"origin" text NOT NULL,
	"root" "bytea" NOT NULL,
	"frontier" "bytea" NOT NULL,
	"checkpoint_note" text NOT NULL,
	CONSTRAINT "evidence_batches_origin_tree_size_pk" PRIMARY KEY("origin","tree_size"),
	CONSTRAINT "evidence_batches_indexes_check" CHECK ("public_panel"."evidence_batches"."first_index" >= 0 and "public_panel"."evidence_batches"."first_index" < "public_panel"."evidence_batches"."tree_size"),
	CONSTRAINT "evidence_batches_root_length" CHECK (octet_length("public_panel"."evidence_batches"."root") = 32),
	CONSTRAINT "evidence_batches_frontier_length" CHECK (octet_length("public_panel"."evidence_batches"."frontier") % 32 = 0 and octet_length("public_panel"."evidence_batches"."frontier") between 32 and 2048)
);
--> statement-breakpoint
CREATE TABLE "public_panel"."evidence_entries" (
	"log_index" bigint,
	"signed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"kind" "public_panel"."evidence_entry_kind" NOT NULL,
	"revision" smallint DEFAULT 0 NOT NULL,
	"ref" text NOT NULL,
	"envelope_sha256" "bytea" NOT NULL,
	"normalized_sha256" "bytea",
	CONSTRAINT "evidence_entries_ref_kind_revision_pk" PRIMARY KEY("ref","kind","revision"),
	CONSTRAINT "evidence_entries_log_index_key" UNIQUE("log_index"),
	CONSTRAINT "evidence_entries_revision_check" CHECK ("public_panel"."evidence_entries"."revision" >= 0),
	CONSTRAINT "evidence_entries_envelope_sha256_length" CHECK (octet_length("public_panel"."evidence_entries"."envelope_sha256") = 32),
	CONSTRAINT "evidence_entries_normalized_sha256_length" CHECK (octet_length("public_panel"."evidence_entries"."normalized_sha256") = 32)
);
--> statement-breakpoint
CREATE TABLE "public_panel"."signing_keys" (
	"valid_from" timestamp with time zone NOT NULL,
	"valid_to" timestamp with time zone,
	"compromised_after" timestamp with time zone,
	"keyid" text PRIMARY KEY NOT NULL,
	"purpose" text NOT NULL,
	"env" text NOT NULL,
	"public_key" "bytea" NOT NULL,
	"custody" text NOT NULL,
	"note_vkey" text,
	CONSTRAINT "signing_keys_purpose_check" CHECK ("public_panel"."signing_keys"."purpose" in ('capture', 'log')),
	CONSTRAINT "signing_keys_env_check" CHECK ("public_panel"."signing_keys"."env" in ('production', 'preview')),
	CONSTRAINT "signing_keys_custody_check" CHECK ("public_panel"."signing_keys"."custody" in ('aws-kms-hsm', 'gcp-kms-software')),
	CONSTRAINT "signing_keys_public_key_length" CHECK (octet_length("public_panel"."signing_keys"."public_key") = 32),
	CONSTRAINT "signing_keys_validity_check" CHECK ("public_panel"."signing_keys"."valid_to" is null or "public_panel"."signing_keys"."valid_to" > "public_panel"."signing_keys"."valid_from")
);
--> statement-breakpoint
CREATE TABLE "public_panel"."timestamp_anchors" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tree_size" bigint NOT NULL,
	"attested_at" timestamp with time zone,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"bitcoin_height" integer,
	"attempts" integer DEFAULT 0 NOT NULL,
	"origin" text NOT NULL,
	"kind" text NOT NULL,
	"provider" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"proof" "bytea",
	CONSTRAINT "timestamp_anchors_batch_kind_provider_key" UNIQUE("origin","tree_size","kind","provider"),
	CONSTRAINT "timestamp_anchors_provider_check" CHECK (("public_panel"."timestamp_anchors"."kind" = 'ots' and "public_panel"."timestamp_anchors"."provider" = 'ots-calendars') or ("public_panel"."timestamp_anchors"."kind" = 'rfc3161' and "public_panel"."timestamp_anchors"."provider" in ('qtsa', 'digicert'))),
	CONSTRAINT "timestamp_anchors_status_check" CHECK ("public_panel"."timestamp_anchors"."status" in ('pending', 'confirmed', 'failed')),
	CONSTRAINT "timestamp_anchors_proof_length" CHECK (octet_length("public_panel"."timestamp_anchors"."proof") <= 10240),
	CONSTRAINT "timestamp_anchors_attempts_check" CHECK ("public_panel"."timestamp_anchors"."attempts" >= 0)
);
--> statement-breakpoint
ALTER TABLE "public_panel"."timestamp_anchors" ADD CONSTRAINT "timestamp_anchors_batch_fk" FOREIGN KEY ("origin","tree_size") REFERENCES "public_panel"."evidence_batches"("origin","tree_size") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "evidence_entries_pending_log_idx" ON "public_panel"."evidence_entries" USING btree ("envelope_sha256") WHERE "public_panel"."evidence_entries"."log_index" is null;--> statement-breakpoint
CREATE INDEX "timestamp_anchors_status_next_attempt_at_idx" ON "public_panel"."timestamp_anchors" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "timestamp_anchors_confirmed_ots_idx" ON "public_panel"."timestamp_anchors" USING btree ("origin","tree_size") WHERE "public_panel"."timestamp_anchors"."kind" = 'ots' and "public_panel"."timestamp_anchors"."status" = 'confirmed';