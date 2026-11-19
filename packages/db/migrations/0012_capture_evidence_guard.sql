-- Custom SQL migration file, put your code below! --
-- A capture's digests are signed into its statement and appended to the transparency log, so the
-- row that points at them can never be rewritten or removed; log_index is set once, when the
-- capture is appended.
create function public_panel.captures_evidence_guard() returns trigger
  language plpgsql
  security invoker
  set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'public_panel.captures rows are immutable evidence and cannot be deleted'
      using errcode = 'restrict_violation';
  end if;
  if new.envelope_sha256 is distinct from old.envelope_sha256
     or new.normalized_sha256 is distinct from old.normalized_sha256 then
    raise exception 'public_panel.captures evidence digests are immutable'
      using errcode = 'restrict_violation';
  end if;
  if old.log_index is not null and new.log_index is distinct from old.log_index then
    raise exception 'public_panel.captures log_index is immutable once set'
      using errcode = 'restrict_violation';
  end if;
  return new;
end
$$;
--> statement-breakpoint
revoke all on function public_panel.captures_evidence_guard() from public;
--> statement-breakpoint
create trigger captures_evidence_guard
  before update or delete on public_panel.captures
  for each row execute function public_panel.captures_evidence_guard();
