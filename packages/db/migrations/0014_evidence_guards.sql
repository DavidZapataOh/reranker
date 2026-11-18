-- The transparency log is append-only: a signed entry, an integrated batch or a published key is
-- never rewritten or removed. The trigger arguments name the only columns that may go from null to
-- a value, once; the rest of the row is compared whole, so a column added later is immutable too.
create function public_panel.evidence_append_only_guard() returns trigger
  language plpgsql
  security invoker
  set search_path = ''
as $$
declare
  settable text[] := tg_argv;
  column_name text;
begin
  if tg_op = 'DELETE' then
    raise exception '%.% rows are immutable evidence and cannot be deleted',
      tg_table_schema, tg_table_name
      using errcode = 'restrict_violation';
  end if;
  foreach column_name in array settable loop
    if to_jsonb(old) -> column_name <> 'null'::jsonb
       and to_jsonb(new) -> column_name is distinct from to_jsonb(old) -> column_name then
      raise exception '%.%.% is immutable once set', tg_table_schema, tg_table_name, column_name
        using errcode = 'restrict_violation';
    end if;
  end loop;
  if (to_jsonb(new) - settable) is distinct from (to_jsonb(old) - settable) then
    raise exception '%.% rows are immutable except for setting %',
      tg_table_schema, tg_table_name, array_to_string(settable, ', ')
      using errcode = 'restrict_violation';
  end if;
  return new;
end
$$;
--> statement-breakpoint
revoke all on function public_panel.evidence_append_only_guard() from public;
--> statement-breakpoint
create trigger evidence_entries_guard
  before update or delete on public_panel.evidence_entries
  for each row execute function public_panel.evidence_append_only_guard('log_index');
--> statement-breakpoint
create trigger evidence_batches_guard
  before update or delete on public_panel.evidence_batches
  for each row execute function public_panel.evidence_append_only_guard('published_at');
--> statement-breakpoint
create trigger signing_keys_guard
  before update or delete on public_panel.signing_keys
  for each row execute function public_panel.evidence_append_only_guard('valid_to', 'compromised_after');
