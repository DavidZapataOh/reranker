create table "app"."leads" (
  "id" uuid primary key default uuidv7(),
  "created_at" timestamptz default now() not null
);
--> statement-breakpoint
create index "leads_created_at_idx" on "app"."leads" ("created_at");
