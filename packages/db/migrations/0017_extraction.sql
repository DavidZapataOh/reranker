-- Token counts, latencies and offsets into one answer stay far below 2^31; disputed counts and
-- ordinals, a few per answer, far below 2^15. The narrow types keep the per-report rows small.
-- squawk-ignore-file prefer-bigint-over-smallint, prefer-bigint-over-int
CREATE TYPE "public_panel"."agreement" AS ENUM('agreed', 'adjudicated', 'single');--> statement-breakpoint
CREATE TYPE "public_panel"."answer_kind" AS ENUM('names_entities', 'no_entities', 'refusal', 'capture_failed');--> statement-breakpoint
CREATE TYPE "public_panel"."entity_kind" AS ENUM('business', 'professional', 'chain', 'platform', 'directory_or_media', 'other');--> statement-breakpoint
CREATE TYPE "public_panel"."places_outcome" AS ENUM('place', 'chain', 'unresolvable');--> statement-breakpoint
CREATE TYPE "public_panel"."resolution_method" AS ENUM('cache', 'rules', 'judge', 'none');--> statement-breakpoint
CREATE TYPE "public_panel"."resolution_status" AS ENUM('resolved', 'chain', 'unresolvable', 'not_attempted', 'platform');--> statement-breakpoint
CREATE TYPE "public_panel"."sentiment" AS ENUM('positive', 'neutral', 'negative');--> statement-breakpoint
CREATE TYPE "public_panel"."stance" AS ENUM('recommendation', 'incidental', 'negative');--> statement-breakpoint
CREATE TABLE "public_panel"."extractions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"cost_amount_micros" "app"."amount_micros" NOT NULL,
	"input_tokens" integer NOT NULL,
	"output_tokens" integer NOT NULL,
	"latency_ms" integer NOT NULL,
	"answer_kind" "public_panel"."answer_kind" NOT NULL,
	"agreement" "public_panel"."agreement" NOT NULL,
	"disputed_count" smallint DEFAULT 0 NOT NULL,
	"judge_used" boolean NOT NULL,
	"capture_id" text NOT NULL,
	"cost_currency" "app"."currency_code" NOT NULL,
	"config_hash" "bytea" NOT NULL,
	"outputs_sha256" "bytea" NOT NULL,
	CONSTRAINT "extractions_capture_id_config_hash_key" UNIQUE("capture_id","config_hash"),
	CONSTRAINT "extractions_config_hash_length" CHECK (octet_length("config_hash") = 32),
	CONSTRAINT "extractions_outputs_sha256_length" CHECK (octet_length("outputs_sha256") = 32),
	CONSTRAINT "extractions_counts_check" CHECK ("public_panel"."extractions"."input_tokens" >= 0 and "public_panel"."extractions"."output_tokens" >= 0 and "public_panel"."extractions"."latency_ms" >= 0 and "public_panel"."extractions"."disputed_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "public_panel"."mentions" (
	"extraction_id" uuid NOT NULL,
	"start_offset" integer NOT NULL,
	"end_offset" integer NOT NULL,
	"resolution_score" real,
	"entity_kind" "public_panel"."entity_kind" NOT NULL,
	"stance" "public_panel"."stance" NOT NULL,
	"sentiment" "public_panel"."sentiment" NOT NULL,
	"resolution_status" "public_panel"."resolution_status" NOT NULL,
	"resolution_method" "public_panel"."resolution_method" NOT NULL,
	"ordinal" smallint,
	"is_target" boolean NOT NULL,
	"entity_key" text NOT NULL,
	"name_hmac" "bytea" NOT NULL,
	"cited_url_hashes" "bytea" DEFAULT '\x'::bytea NOT NULL,
	"name_norm" text,
	"place_id" text,
	CONSTRAINT "mentions_extraction_id_start_offset_pk" PRIMARY KEY("extraction_id","start_offset"),
	CONSTRAINT "mentions_name_hmac_length" CHECK (octet_length("name_hmac") = 32),
	CONSTRAINT "mentions_cited_url_hashes_length" CHECK (octet_length("public_panel"."mentions"."cited_url_hashes") % 32 = 0 and octet_length("public_panel"."mentions"."cited_url_hashes") <= 2048),
	CONSTRAINT "mentions_offsets_check" CHECK ("public_panel"."mentions"."start_offset" >= 0 and "public_panel"."mentions"."end_offset" > "public_panel"."mentions"."start_offset"),
	CONSTRAINT "mentions_ordinal_check" CHECK ("public_panel"."mentions"."ordinal" is null or ("public_panel"."mentions"."ordinal" >= 1 and "public_panel"."mentions"."stance" = 'recommendation')),
	CONSTRAINT "mentions_resolution_score_check" CHECK ("public_panel"."mentions"."resolution_score" >= 0 and "public_panel"."mentions"."resolution_score" <= 1),
	CONSTRAINT "mentions_professional_name_check" CHECK ("public_panel"."mentions"."entity_kind" <> 'professional' or "public_panel"."mentions"."name_norm" is null)
);
--> statement-breakpoint
CREATE TABLE "public_panel"."places" (
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL,
	"validated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"score" real,
	"outcome" "public_panel"."places_outcome" NOT NULL,
	"method" "public_panel"."resolution_method" NOT NULL,
	"name_hmac" "bytea" NOT NULL,
	"config_hash" "bytea" NOT NULL,
	"geo_key" text NOT NULL,
	"category_key" text NOT NULL,
	"place_id" text,
	CONSTRAINT "places_name_hmac_geo_key_category_key_config_hash_pk" PRIMARY KEY("name_hmac","geo_key","category_key","config_hash"),
	CONSTRAINT "places_name_hmac_length" CHECK (octet_length("name_hmac") = 32),
	CONSTRAINT "places_config_hash_length" CHECK (octet_length("config_hash") = 32),
	CONSTRAINT "places_place_id_check" CHECK (("public_panel"."places"."outcome" = 'place') = ("public_panel"."places"."place_id" is not null)),
	CONSTRAINT "places_score_check" CHECK ("public_panel"."places"."score" >= 0 and "public_panel"."places"."score" <= 1)
);
--> statement-breakpoint
ALTER TABLE "public_panel"."extractions" ADD CONSTRAINT "extractions_capture_id_captures_id_fk" FOREIGN KEY ("capture_id") REFERENCES "public_panel"."captures"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "public_panel"."mentions" ADD CONSTRAINT "mentions_extraction_id_extractions_id_fk" FOREIGN KEY ("extraction_id") REFERENCES "public_panel"."extractions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "extractions_disputed_created_at_idx" ON "public_panel"."extractions" USING btree ("created_at") WHERE "public_panel"."extractions"."disputed_count" > 0;--> statement-breakpoint
CREATE INDEX "mentions_entity_key_idx" ON "public_panel"."mentions" USING btree ("entity_key");--> statement-breakpoint
CREATE INDEX "places_place_validated_at_idx" ON "public_panel"."places" USING btree ("validated_at") WHERE "public_panel"."places"."outcome" = 'place';