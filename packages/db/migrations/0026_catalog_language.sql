-- Constant defaults are stored in the catalog, so adding the columns rewrites no rows. No seed
-- version has been mirrored yet, so both tables are empty: validating the checks scans nothing,
-- and the migrator applies every file in one transaction, so NOT VALID followed by VALIDATE would
-- hold the same lock.
-- squawk-ignore-file constraint-missing-not-valid
ALTER TABLE "public_panel"."intents" ADD COLUMN "register_profile" "public_panel"."register_profile" DEFAULT 'co' NOT NULL;--> statement-breakpoint
ALTER TABLE "public_panel"."intents" ADD COLUMN "language" text DEFAULT 'es' NOT NULL;--> statement-breakpoint
ALTER TABLE "public_panel"."personas" ADD COLUMN "register_profile" "public_panel"."register_profile" DEFAULT 'co' NOT NULL;--> statement-breakpoint
ALTER TABLE "public_panel"."personas" ADD COLUMN "language" text DEFAULT 'es' NOT NULL;--> statement-breakpoint
ALTER TABLE "public_panel"."intents" ADD CONSTRAINT "intents_language_check" CHECK ("public_panel"."intents"."language" in ('es', 'en', 'pt', 'fr', 'de', 'it'));--> statement-breakpoint
ALTER TABLE "public_panel"."personas" ADD CONSTRAINT "personas_language_check" CHECK ("public_panel"."personas"."language" in ('es', 'en', 'pt', 'fr', 'de', 'it'));
