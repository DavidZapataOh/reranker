-- Domains have no IF NOT EXISTS form; the guards keep a rerun after an interrupted deploy safe.
-- Adding a currency later means replacing this CHECK in a new migration, never editing this one.
do $$
begin
  create domain public.currency_code as text
    constraint currency_code_check check (value in ('COP', 'USD', 'EUR'));
exception when duplicate_object then
  null;
end
$$;
--> statement-breakpoint
-- Amounts stay within Number.MAX_SAFE_INTEGER so they round-trip through JavaScript unchanged.
do $$
begin
  create domain public.amount_minor as bigint
    constraint amount_minor_check check (value between -9007199254740991 and 9007199254740991);
exception when duplicate_object then
  null;
end
$$;
--> statement-breakpoint
do $$
begin
  create domain public.amount_micros as bigint
    constraint amount_micros_check check (value between 0 and 9007199254740991);
exception when duplicate_object then
  null;
end
$$;
--> statement-breakpoint
-- Nothing revokes USAGE on public types from PUBLIC; the grant keeps that true if it ever does.
grant usage on domain public.currency_code, public.amount_minor, public.amount_micros
  to app_tenant, app_system;
