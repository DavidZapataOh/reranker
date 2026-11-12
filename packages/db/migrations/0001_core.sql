create extension if not exists pg_stat_statements;
--> statement-breakpoint
-- Roles are cluster-wide: a branch restored from one that already ran this keeps them.
do $$
begin
  if not exists (select from pg_roles where rolname = 'app_tenant') then
    create role app_tenant nologin;
  end if;
  if not exists (select from pg_roles where rolname = 'app_system') then
    create role app_system nologin;
  end if;
end
$$;
--> statement-breakpoint
-- Without app.tenant_ids set in the transaction this is NULL, so every tenant policy matches zero rows.
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
-- Without "for role" these apply to the role running migrations, which owns every table it creates.
alter default privileges in schema app
  grant select, insert, update, delete on tables to app_tenant, app_system;
--> statement-breakpoint
alter default privileges in schema public_panel grant select on tables to app_tenant;
--> statement-breakpoint
alter default privileges in schema public_panel
  grant select, insert, update, delete on tables to app_system;
--> statement-breakpoint
alter default privileges in schema auth
  grant select, insert, update, delete on tables to app_system;
--> statement-breakpoint
alter default privileges in schema ops
  grant select, insert, update, delete on tables to app_system;
--> statement-breakpoint
-- Sequences behind identity columns need usage for inserts to work.
alter default privileges in schema app grant usage on sequences to app_tenant, app_system;
--> statement-breakpoint
alter default privileges in schema public_panel, auth, ops grant usage on sequences to app_system;
