create extension if not exists pg_stat_statements;
--> statement-breakpoint
-- Roles are cluster-wide: tolerate a restored branch and databases migrating at the same time.
do $$
declare
  role_name text;
begin
  foreach role_name in array array['app_tenant', 'app_system'] loop
    begin
      execute format('create role %I nologin', role_name);
    exception when duplicate_object or unique_violation then
      null;
    end;
  end loop;
end
$$;
--> statement-breakpoint
create function app.current_tenant_ids() returns uuid[]
  language sql stable parallel safe
  as $$ select nullif(current_setting('app.tenant_ids', true), '')::uuid[] $$;
--> statement-breakpoint
revoke all on schema app, auth, public_panel, ops from public;
--> statement-breakpoint
revoke all on function app.current_tenant_ids() from public;
--> statement-breakpoint
grant usage on schema app, public_panel to app_tenant;
--> statement-breakpoint
grant usage on schema app, auth, public_panel, ops to app_system;
--> statement-breakpoint
grant execute on function app.current_tenant_ids() to app_tenant, app_system;
--> statement-breakpoint
alter default privileges for role reranker_owner in schema app
  grant select, insert, update, delete on tables to app_tenant, app_system;
--> statement-breakpoint
alter default privileges for role reranker_owner in schema public_panel
  grant select on tables to app_tenant;
--> statement-breakpoint
alter default privileges for role reranker_owner in schema public_panel
  grant select, insert, update, delete on tables to app_system;
--> statement-breakpoint
alter default privileges for role reranker_owner in schema auth
  grant select, insert, update, delete on tables to app_system;
--> statement-breakpoint
alter default privileges for role reranker_owner in schema ops
  grant select, insert, update, delete on tables to app_system;
