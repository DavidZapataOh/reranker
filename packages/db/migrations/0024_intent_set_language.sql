-- A constant default is stored in the catalog, so adding the column rewrites no rows. No deployed
-- code writes intent sets yet, so the table holds a handful of rows: validating the check scans
-- them under the runner's lock_timeout, and the migrator applies every file in one transaction,
-- so NOT VALID followed by VALIDATE would hold the same lock.
-- squawk-ignore-file constraint-missing-not-valid
ALTER TABLE "public_panel"."intent_sets" ADD COLUMN "language" text DEFAULT 'es' NOT NULL;--> statement-breakpoint
ALTER TABLE "public_panel"."intent_sets" ADD CONSTRAINT "intent_sets_language_check" CHECK ("public_panel"."intent_sets"."language" in ('es', 'en', 'pt', 'fr', 'de', 'it'));
