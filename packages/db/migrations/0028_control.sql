-- Run counts (at most ten a day), run lengths (truncated at 400) and a regime's capture count
-- stay far below 2^15 and 2^31. The narrow types keep a canary day's rows small.
-- squawk-ignore-file prefer-bigint-over-smallint, prefer-bigint-over-int
CREATE TYPE "public_panel"."regime_cause" AS ENUM('initial', 'model', 'drift');--> statement-breakpoint
CREATE TABLE "public_panel"."canary_baselines" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"from_day" date NOT NULL,
	"to_day" date NOT NULL,
	"engine" "public_panel"."capture_engine" NOT NULL,
	"channel" "public_panel"."capture_channel" NOT NULL,
	"p0" real NOT NULL,
	"mu0" real,
	"sigma" real,
	"h" real,
	"prompt_id" text NOT NULL,
	"reference_entities" text[] NOT NULL,
	"extractor_config_hash" "bytea" NOT NULL,
	CONSTRAINT "canary_baselines_key" UNIQUE("engine","channel","prompt_id","extractor_config_hash"),
	CONSTRAINT "canary_baselines_extractor_config_hash_length" CHECK (octet_length("extractor_config_hash") = 32),
	CONSTRAINT "canary_baselines_days_check" CHECK ("public_panel"."canary_baselines"."from_day" <= "public_panel"."canary_baselines"."to_day"),
	CONSTRAINT "canary_baselines_p0_check" CHECK ("public_panel"."canary_baselines"."p0" >= 0 and "public_panel"."canary_baselines"."p0" <= 1),
	CONSTRAINT "canary_baselines_fit_check" CHECK (("public_panel"."canary_baselines"."mu0" is null) = ("public_panel"."canary_baselines"."sigma" is null) and ("public_panel"."canary_baselines"."sigma" is null) = ("public_panel"."canary_baselines"."h" is null) and ("public_panel"."canary_baselines"."sigma" is null or "public_panel"."canary_baselines"."sigma" > 0))
);
--> statement-breakpoint
CREATE TABLE "public_panel"."canary_bocpd" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"day" date NOT NULL,
	"cell" text NOT NULL,
	"state" jsonb NOT NULL,
	CONSTRAINT "canary_bocpd_cell_key" UNIQUE("cell")
);
--> statement-breakpoint
CREATE TABLE "public_panel"."canary_cusum" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"day" date NOT NULL,
	"engine" "public_panel"."capture_engine" NOT NULL,
	"channel" "public_panel"."capture_channel" NOT NULL,
	"x" real NOT NULL,
	"s_up" real NOT NULL,
	"s_down" real NOT NULL,
	"y" smallint NOT NULL,
	"n" smallint NOT NULL,
	"map_run_length" smallint NOT NULL,
	"alarm" boolean NOT NULL,
	"prompt_id" text NOT NULL,
	CONSTRAINT "canary_cusum_key" UNIQUE("day","engine","channel","prompt_id"),
	CONSTRAINT "canary_cusum_counts_check" CHECK ("public_panel"."canary_cusum"."n" > 0 and "public_panel"."canary_cusum"."y" >= 0 and "public_panel"."canary_cusum"."y" <= "public_panel"."canary_cusum"."n" and "public_panel"."canary_cusum"."map_run_length" >= 0)
);
--> statement-breakpoint
CREATE TABLE "public_panel"."control_daily" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"day" date NOT NULL,
	"engine" "public_panel"."capture_engine" NOT NULL,
	"channel" "public_panel"."capture_channel" NOT NULL,
	"value" real NOT NULL,
	"n" smallint NOT NULL,
	"geo_key" text NOT NULL,
	"prompt_id" text,
	"metric" text NOT NULL,
	"extractor_config_hash" "bytea",
	CONSTRAINT "control_daily_key" UNIQUE NULLS NOT DISTINCT("day","engine","channel","geo_key","prompt_id","metric"),
	CONSTRAINT "control_daily_extractor_config_hash_length" CHECK (octet_length("extractor_config_hash") = 32),
	CONSTRAINT "control_daily_n_check" CHECK ("public_panel"."control_daily"."n" >= 0)
);
--> statement-breakpoint
CREATE TABLE "public_panel"."model_regimes" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"opened_at" timestamp with time zone NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"capture_count" integer DEFAULT 0 NOT NULL,
	"engine" "public_panel"."capture_engine" NOT NULL,
	"channel" "public_panel"."capture_channel" NOT NULL,
	"provider" "public_panel"."capture_provider" NOT NULL,
	"cause" "public_panel"."regime_cause" NOT NULL,
	"model_reported" text,
	"first_capture_id" text,
	"detail" jsonb,
	"envelope_sha256" "bytea",
	CONSTRAINT "model_regimes_key" UNIQUE("engine","channel","provider","opened_at"),
	CONSTRAINT "model_regimes_envelope_sha256_length" CHECK (octet_length("envelope_sha256") = 32),
	CONSTRAINT "model_regimes_capture_count_check" CHECK ("public_panel"."model_regimes"."capture_count" >= 0),
	CONSTRAINT "model_regimes_seen_check" CHECK ("public_panel"."model_regimes"."first_seen_at" <= "public_panel"."model_regimes"."last_seen_at")
);
--> statement-breakpoint
ALTER TABLE "public_panel"."model_regimes" ADD CONSTRAINT "model_regimes_first_capture_id_captures_id_fk" FOREIGN KEY ("first_capture_id") REFERENCES "public_panel"."captures"("id") ON DELETE no action ON UPDATE no action;