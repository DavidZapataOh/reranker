-- The last deployment reading "source" is already retired.
-- squawk-ignore ban-drop-column
alter table "app"."leads" drop column "source";
