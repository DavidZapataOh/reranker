CREATE TABLE "ops"."capture_tasks" (
	"slot_id" text PRIMARY KEY NOT NULL,
	"measurement_id" text NOT NULL,
	"provider" text NOT NULL,
	"engine" text NOT NULL,
	"claim_token" uuid NOT NULL,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"posting_at" timestamp with time zone,
	"reservation_id" uuid,
	"spend" jsonb,
	"vendor_task_id" text,
	"posted_at" timestamp with time zone,
	"fetching_at" timestamp with time zone,
	"collected_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "capture_tasks_measurement_id_open_idx" ON "ops"."capture_tasks" USING btree ("measurement_id") WHERE "ops"."capture_tasks"."collected_at" is null;