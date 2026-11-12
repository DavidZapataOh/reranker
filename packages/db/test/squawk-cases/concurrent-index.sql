-- squawk-ignore-file ban-concurrent-index-creation-in-transaction
CREATE INDEX CONCURRENTLY IF NOT EXISTS "businesses_name_idx" ON "app"."businesses" USING btree ("name");
