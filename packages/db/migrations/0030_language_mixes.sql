-- DataForSEO location codes are Google Ads criteria ids, all below 2^31.
-- squawk-ignore-file prefer-bigint-over-int
CREATE TABLE "public_panel"."language_mix_claims" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"key" text NOT NULL,
	CONSTRAINT "language_mix_claims_key_key" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "public_panel"."language_mixes" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"cost_amount_micros" "app"."amount_micros" NOT NULL,
	"cost_currency" "app"."currency_code" NOT NULL,
	"location_code" integer NOT NULL,
	"geo_key" text NOT NULL,
	"category_key" text NOT NULL,
	"config_hash" "bytea" NOT NULL,
	"level" text NOT NULL,
	"source" text,
	"shares" jsonb NOT NULL,
	"volumes" jsonb NOT NULL,
	CONSTRAINT "language_mixes_key" UNIQUE("geo_key","category_key","config_hash"),
	CONSTRAINT "language_mixes_level_check" CHECK ("public_panel"."language_mixes"."level" in ('city', 'region', 'country')),
	CONSTRAINT "language_mixes_source_check" CHECK ("public_panel"."language_mixes"."source" in ('google_ads', 'ai_search')),
	CONSTRAINT "language_mixes_config_hash_length" CHECK (octet_length("config_hash") = 32)
);
