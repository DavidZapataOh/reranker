CREATE TABLE "ops"."capture_task_batches" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"measurement_id" text NOT NULL,
	"provider" text NOT NULL,
	"engine" text NOT NULL,
	"slot_ids" text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ops"."capture_tasks" ADD COLUMN "batch_id" uuid;