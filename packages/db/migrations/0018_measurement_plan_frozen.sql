-- A measurement row is created before its plan is chosen; digest and slot count arrive with the
-- seal. No deployed code reads either column, so relaxing them breaks no client. The table holds
-- one row per measurement, so validating the new check scans a few rows under the runner's
-- lock_timeout, and the migrator applies every file in one transaction, so NOT VALID followed by
-- VALIDATE would hold the same lock.
-- squawk-ignore-file ban-drop-not-null, constraint-missing-not-valid
ALTER TABLE "public_panel"."measurement_plans" ALTER COLUMN "digest" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "public_panel"."measurement_plans" ALTER COLUMN "slot_count" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "public_panel"."measurement_plans" ADD CONSTRAINT "measurement_plans_frozen_sealed" CHECK ("public_panel"."measurement_plans"."frozen_at" is null or ("public_panel"."measurement_plans"."digest" is not null and "public_panel"."measurement_plans"."plan_envelope_sha256" is not null and "public_panel"."measurement_plans"."slot_count" is not null));
