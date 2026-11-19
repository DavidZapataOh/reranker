-- successes and trials count answers in one measurement, a few hundred for a free report and far
-- below 2^31 for any panel; the narrow type keeps a report's rows within their storage budget.
-- squawk-ignore-file prefer-bigint-over-int
CREATE TYPE "public_panel"."estimate_level" AS ENUM('invisible', 'sometimes', 'on_the_list', 'regular');--> statement-breakpoint
CREATE TYPE "public_panel"."estimate_metric" AS ENUM('recommendation_rate', 'prominence', 'score', 'names_entities_rate');--> statement-breakpoint
CREATE TYPE "public_panel"."estimate_scope" AS ENUM('overall', 'engine', 'intent', 'canonical');--> statement-breakpoint
CREATE TYPE "public_panel"."estimate_sufficiency" AS ENUM('sufficient', 'orientative', 'insufficient');--> statement-breakpoint
CREATE TABLE "public_panel"."estimates" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"computed_at" timestamp with time zone NOT NULL,
	"measurement_id" uuid NOT NULL,
	"estimate" real NOT NULL,
	"lower" real NOT NULL,
	"upper" real NOT NULL,
	"effective_trials" real NOT NULL,
	"design_effect" real NOT NULL,
	"successes" integer NOT NULL,
	"trials" integer NOT NULL,
	"scope" "public_panel"."estimate_scope" NOT NULL,
	"metric" "public_panel"."estimate_metric" NOT NULL,
	"level" "public_panel"."estimate_level",
	"sufficiency" "public_panel"."estimate_sufficiency",
	"entity_key" text NOT NULL,
	"scope_key" text,
	"methodology_hash" "bytea" NOT NULL,
	"intent_set_hash" "bytea" NOT NULL,
	"extractor_config_hash" "bytea" NOT NULL,
	"seed" "bytea" NOT NULL,
	CONSTRAINT "estimates_key" UNIQUE NULLS NOT DISTINCT("measurement_id","entity_key","scope","scope_key","metric","methodology_hash"),
	CONSTRAINT "estimates_methodology_hash_length" CHECK (octet_length("methodology_hash") = 32),
	CONSTRAINT "estimates_intent_set_hash_length" CHECK (octet_length("intent_set_hash") = 32),
	CONSTRAINT "estimates_extractor_config_hash_length" CHECK (octet_length("extractor_config_hash") = 32),
	CONSTRAINT "estimates_seed_length" CHECK (octet_length("seed") = 32),
	CONSTRAINT "estimates_scope_key_check" CHECK (("public_panel"."estimates"."scope_key" is null) = ("public_panel"."estimates"."scope" in ('overall', 'canonical'))),
	CONSTRAINT "estimates_entity_key_check" CHECK (("public_panel"."estimates"."entity_key" = '*') = ("public_panel"."estimates"."metric" = 'names_entities_rate')),
	CONSTRAINT "estimates_score_fields_check" CHECK (("public_panel"."estimates"."metric" = 'score') = ("public_panel"."estimates"."level" is not null) and ("public_panel"."estimates"."level" is null) = ("public_panel"."estimates"."sufficiency" is null)),
	CONSTRAINT "estimates_interval_check" CHECK ("public_panel"."estimates"."lower" <= "public_panel"."estimates"."estimate" and "public_panel"."estimates"."estimate" <= "public_panel"."estimates"."upper"),
	CONSTRAINT "estimates_counts_check" CHECK ("public_panel"."estimates"."successes" >= 0 and "public_panel"."estimates"."successes" <= "public_panel"."estimates"."trials" and "public_panel"."estimates"."effective_trials" >= 0)
);
--> statement-breakpoint
ALTER TABLE "public_panel"."estimates" ADD CONSTRAINT "estimates_measurement_id_measurement_plans_id_fk" FOREIGN KEY ("measurement_id") REFERENCES "public_panel"."measurement_plans"("id") ON DELETE no action ON UPDATE no action;