ALTER TABLE "app"."free_reports" ADD CONSTRAINT "free_reports_business_fk" FOREIGN KEY ("tenant_id", "business_id") REFERENCES "app"."businesses"("tenant_id", "id");
