alter table "app"."leads" add constraint "leads_report_fk"
  foreign key ("tenant_id", "report_id") references "app"."free_reports" ("tenant_id", "id");
