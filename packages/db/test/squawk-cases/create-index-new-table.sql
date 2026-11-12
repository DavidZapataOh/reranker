CREATE TABLE "app"."widgets" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"label" text NOT NULL
);
--> statement-breakpoint
CREATE INDEX "widgets_tenant_id_idx" ON "app"."widgets" USING btree ("tenant_id");
