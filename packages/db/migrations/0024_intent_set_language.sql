-- A constant default is stored in the catalog, so adding the column rewrites no rows. No deployed
-- code writes intent sets yet, so old code is unaffected by the new column.
CREATE TYPE "public_panel"."measurement_language" AS ENUM('es', 'en', 'pt', 'fr', 'de', 'it');--> statement-breakpoint
ALTER TABLE "public_panel"."intent_sets" ADD COLUMN "language" "public_panel"."measurement_language" DEFAULT 'es' NOT NULL;
