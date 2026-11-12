CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
--> statement-breakpoint
-- Roles are cluster-wide: a restored or second database on the same branch already has them.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_tenant') THEN
    CREATE ROLE app_tenant NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_system') THEN
    CREATE ROLE app_system NOLOGIN;
  END IF;
END
$$;
--> statement-breakpoint
-- Without the variable the result is NULL, so every tenant policy matches zero rows (fails closed).
CREATE FUNCTION app.current_tenant_ids() RETURNS uuid[]
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT nullif(current_setting('app.tenant_ids', true), '')::uuid[] $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.current_tenant_ids() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.current_tenant_ids() TO app_tenant, app_system;
--> statement-breakpoint
REVOKE ALL ON SCHEMA app, auth, public_panel, ops FROM PUBLIC;
--> statement-breakpoint
GRANT USAGE ON SCHEMA app, public_panel TO app_tenant;
--> statement-breakpoint
GRANT USAGE ON SCHEMA app, auth, public_panel, ops TO app_system;
--> statement-breakpoint
-- Default privileges belong to the role running migrations (the branch owner), which creates every table.
ALTER DEFAULT PRIVILEGES IN SCHEMA app
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_tenant, app_system;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public_panel GRANT SELECT ON TABLES TO app_tenant;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public_panel
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_system;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA auth
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_system;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA ops
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_system;
