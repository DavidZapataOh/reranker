-- squawk-disable-assume-in-transaction
create index concurrently if not exists "leads_created_at_idx" on "app"."leads" ("created_at");
