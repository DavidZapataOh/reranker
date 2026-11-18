-- A set holds a few hundred variants and a seed version about ten thousand, far below 2^15 and
-- 2^31; the narrow integers keep an intent_sets row under 256 bytes.
-- squawk-ignore-file prefer-bigint-over-smallint, prefer-bigint-over-int
CREATE TYPE "public_panel"."category_archetype" AS ENUM('health', 'beauty_wellness', 'lodging', 'food', 'home_auto_services', 'local_retail', 'professional_services', 'real_estate', 'education', 'online_national');--> statement-breakpoint
CREATE TYPE "public_panel"."intent_kind" AS ENUM('discovery', 'specialty', 'zone', 'price', 'urgency', 'trust', 'insurance_or_payment', 'ranking', 'brand');--> statement-breakpoint
CREATE TYPE "public_panel"."intent_set_kind" AS ENUM('seed', 'generated', 'template');--> statement-breakpoint
CREATE TYPE "public_panel"."paraphrase_format" AS ENUM('open_question', 'list_request', 'keyword', 'constraint');--> statement-breakpoint
CREATE TYPE "public_panel"."paraphrase_generator" AS ENUM('openai', 'gemini', 'template', 'human');--> statement-breakpoint
CREATE TYPE "public_panel"."question_scope" AS ENUM('local', 'national');--> statement-breakpoint
CREATE TYPE "public_panel"."register_profile" AS ENUM('neutral', 'co');--> statement-breakpoint
CREATE TYPE "public_panel"."speech_register" AS ENUM('tu', 'usted');--> statement-breakpoint
CREATE TABLE "public_panel"."categories" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"key" text NOT NULL,
	"label_key" text NOT NULL,
	"archetype" "public_panel"."category_archetype" NOT NULL,
	"places_types" text[] NOT NULL,
	"default_scope" "public_panel"."question_scope" NOT NULL,
	"register" "public_panel"."speech_register" NOT NULL,
	CONSTRAINT "categories_key_key" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "public_panel"."intent_sets" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"kind" "public_panel"."intent_set_kind" NOT NULL,
	"scope" "public_panel"."question_scope" NOT NULL,
	"register_profile" "public_panel"."register_profile" NOT NULL,
	"generators" smallint NOT NULL,
	"variant_count" smallint NOT NULL,
	"set_id" text NOT NULL,
	"version" text NOT NULL,
	"category_key" text NOT NULL,
	"content_hash" "bytea" NOT NULL,
	"merkle_root" "bytea" NOT NULL,
	"generator_config_hash" "bytea",
	"artifact_sha256" "bytea",
	CONSTRAINT "intent_sets_set_id_key" UNIQUE("set_id"),
	CONSTRAINT "intent_sets_content_hash_key" UNIQUE("content_hash"),
	CONSTRAINT "intent_sets_set_id_check" CHECK ("public_panel"."intent_sets"."set_id" ~ '^is_[0-9a-f]{16}$'),
	CONSTRAINT "intent_sets_generators_check" CHECK ("public_panel"."intent_sets"."generators" between 0 and 2),
	CONSTRAINT "intent_sets_content_hash_length" CHECK (octet_length("content_hash") = 32),
	CONSTRAINT "intent_sets_merkle_root_length" CHECK (octet_length("merkle_root") = 32),
	CONSTRAINT "intent_sets_generator_config_hash_length" CHECK (octet_length("generator_config_hash") = 32),
	CONSTRAINT "intent_sets_artifact_sha256_length" CHECK (octet_length("artifact_sha256") = 32)
);
--> statement-breakpoint
CREATE TABLE "public_panel"."intents" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"prompt_set" text NOT NULL,
	"intent_id" text NOT NULL,
	"category" text NOT NULL,
	"kind" "public_panel"."intent_kind" NOT NULL,
	"slug" text NOT NULL,
	"label_key" text NOT NULL,
	"demand_weight" double precision NOT NULL,
	"free_report" boolean NOT NULL,
	"canonical_paraphrase_id" text NOT NULL,
	CONSTRAINT "intents_prompt_set_intent_id_key" UNIQUE("prompt_set","intent_id")
);
--> statement-breakpoint
CREATE TABLE "public_panel"."paraphrases" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"prompt_set" text NOT NULL,
	"paraphrase_id" text NOT NULL,
	"intent_id" text NOT NULL,
	"text" text NOT NULL,
	"format" "public_panel"."paraphrase_format" NOT NULL,
	"generator" "public_panel"."paraphrase_generator" NOT NULL,
	"human_reviewed" boolean NOT NULL,
	CONSTRAINT "paraphrases_prompt_set_paraphrase_id_key" UNIQUE("prompt_set","paraphrase_id")
);
--> statement-breakpoint
CREATE TABLE "public_panel"."personas" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"prompt_set" text NOT NULL,
	"persona_id" text NOT NULL,
	"category" text NOT NULL,
	"preamble" text NOT NULL,
	CONSTRAINT "personas_prompt_set_persona_id_key" UNIQUE("prompt_set","persona_id")
);
--> statement-breakpoint
CREATE TABLE "public_panel"."prompt_sets" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"version" text NOT NULL,
	"content_hash" "bytea" NOT NULL,
	"merkle_root" "bytea" NOT NULL,
	"variant_count" integer NOT NULL,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "prompt_sets_version_key" UNIQUE("version"),
	CONSTRAINT "prompt_sets_content_hash_key" UNIQUE("content_hash"),
	CONSTRAINT "prompt_sets_content_hash_length" CHECK (octet_length("content_hash") = 32),
	CONSTRAINT "prompt_sets_merkle_root_length" CHECK (octet_length("merkle_root") = 32)
);
--> statement-breakpoint
ALTER TABLE "public_panel"."intents" ADD CONSTRAINT "intents_prompt_set_prompt_sets_version_fk" FOREIGN KEY ("prompt_set") REFERENCES "public_panel"."prompt_sets"("version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "public_panel"."intents" ADD CONSTRAINT "intents_category_categories_key_fk" FOREIGN KEY ("category") REFERENCES "public_panel"."categories"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "public_panel"."paraphrases" ADD CONSTRAINT "paraphrases_intent_fk" FOREIGN KEY ("prompt_set","intent_id") REFERENCES "public_panel"."intents"("prompt_set","intent_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "public_panel"."personas" ADD CONSTRAINT "personas_prompt_set_prompt_sets_version_fk" FOREIGN KEY ("prompt_set") REFERENCES "public_panel"."prompt_sets"("version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "public_panel"."personas" ADD CONSTRAINT "personas_category_categories_key_fk" FOREIGN KEY ("category") REFERENCES "public_panel"."categories"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "intent_sets_reuse_idx" ON "public_panel"."intent_sets" USING btree ("category_key","scope","register_profile","generator_config_hash","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "intents_category_idx" ON "public_panel"."intents" USING btree ("category");--> statement-breakpoint
CREATE INDEX "paraphrases_prompt_set_intent_id_idx" ON "public_panel"."paraphrases" USING btree ("prompt_set","intent_id");--> statement-breakpoint
CREATE INDEX "personas_category_idx" ON "public_panel"."personas" USING btree ("category");