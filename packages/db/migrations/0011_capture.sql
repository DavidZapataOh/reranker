-- Narrow integers keep a capture row near 280 bytes: slots, attempts, HTTP statuses and parser
-- versions stay far below 2^15, and provider codes, byte counts and latencies far below 2^31.
-- squawk-ignore-file prefer-bigint-over-smallint, prefer-bigint-over-int
CREATE TYPE "public_panel"."capture_channel" AS ENUM('ui-vendor', 'ui-own', 'api');--> statement-breakpoint
CREATE TYPE "public_panel"."capture_engine" AS ENUM('chatgpt', 'gemini', 'google-ai-overview', 'perplexity');--> statement-breakpoint
CREATE TYPE "public_panel"."capture_mode" AS ENUM('live', 'task');--> statement-breakpoint
CREATE TYPE "public_panel"."capture_provider" AS ENUM('dataforseo', 'brightdata', 'openai');--> statement-breakpoint
CREATE TYPE "public_panel"."capture_status" AS ENUM('succeeded', 'provider_error', 'timeout');--> statement-breakpoint
CREATE TABLE "public_panel"."captures" (
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL,
	"cost_amount_micros" "app"."amount_micros" NOT NULL,
	"log_index" bigint,
	"measurement_id" uuid NOT NULL,
	"engine" "public_panel"."capture_engine" NOT NULL,
	"channel" "public_panel"."capture_channel" NOT NULL,
	"provider" "public_panel"."capture_provider" NOT NULL,
	"mode" "public_panel"."capture_mode" NOT NULL,
	"status" "public_panel"."capture_status" NOT NULL,
	"provider_status_code" integer,
	"response_bytes" integer NOT NULL,
	"latency_ms" integer NOT NULL,
	"slot_index" smallint NOT NULL,
	"attempt" smallint NOT NULL,
	"http_status" smallint,
	"parser_version" smallint,
	"late" boolean DEFAULT false NOT NULL,
	"id" text PRIMARY KEY NOT NULL,
	"cost_currency" "app"."currency_code" NOT NULL,
	"intent_set_id" text NOT NULL,
	"intent_id" text NOT NULL,
	"model_reported" text,
	"envelope_sha256" "bytea" NOT NULL,
	"normalized_sha256" "bytea",
	CONSTRAINT "captures_log_index_key" UNIQUE("log_index"),
	CONSTRAINT "captures_id_check" CHECK ("public_panel"."captures"."id" ~ '^cap_[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "captures_envelope_sha256_length" CHECK (octet_length("public_panel"."captures"."envelope_sha256") = 32),
	CONSTRAINT "captures_normalized_sha256_length" CHECK (octet_length("public_panel"."captures"."normalized_sha256") = 32)
);
--> statement-breakpoint
CREATE TABLE "public_panel"."measurement_plans" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"purpose" text NOT NULL,
	"ref_type" text NOT NULL,
	"ref_id" text NOT NULL,
	"digest" "bytea" NOT NULL,
	"plan_envelope_sha256" "bytea",
	"slot_count" smallint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"frozen_at" timestamp with time zone,
	CONSTRAINT "measurement_plans_purpose_check" CHECK ("public_panel"."measurement_plans"."purpose" in ('free-report', 'control-canary', 'quality-canary', 'benchmark', 'contract-test')),
	CONSTRAINT "measurement_plans_digest_length" CHECK (octet_length("public_panel"."measurement_plans"."digest") = 32),
	CONSTRAINT "measurement_plans_plan_envelope_sha256_length" CHECK (octet_length("public_panel"."measurement_plans"."plan_envelope_sha256") = 32)
);
--> statement-breakpoint
ALTER TABLE "public_panel"."captures" ADD CONSTRAINT "captures_measurement_id_measurement_plans_id_fk" FOREIGN KEY ("measurement_id") REFERENCES "public_panel"."measurement_plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "captures_one_success" ON "public_panel"."captures" USING btree ("measurement_id","slot_index") WHERE "public_panel"."captures"."status" = 'succeeded';--> statement-breakpoint
CREATE INDEX "captures_pending_log_idx" ON "public_panel"."captures" USING btree ("envelope_sha256") WHERE "public_panel"."captures"."log_index" is null;--> statement-breakpoint
CREATE INDEX "captures_intent_set_id_intent_id_engine_idx" ON "public_panel"."captures" USING btree ("intent_set_id","intent_id","engine");--> statement-breakpoint
CREATE INDEX "captures_engine_captured_at_idx" ON "public_panel"."captures" USING btree ("engine","captured_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "measurement_plans_ref_type_ref_id_idx" ON "public_panel"."measurement_plans" USING btree ("ref_type","ref_id");