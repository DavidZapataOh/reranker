-- breaker_record answers 'open' both for the call that opens the breaker and for every call while
-- it stays open, so it cannot tell a move from a stay. This records the same outcome and also
-- returns the state before it, read under the row lock that breaker_record then takes again in
-- the same transaction, so exactly one call sees each move.
create function ops.breaker_record_transition(
  p_provider text, p_account text, p_failure boolean, p_min_calls int, p_ratio float8, p_open_ms int
)
  returns table (state text, previous text)
  language plpgsql
  security invoker
  set search_path = pg_catalog, ops, app, pg_temp
as $$
#variable_conflict use_column
declare
  v_row ops.breaker_state;
  v_previous text;
begin
  insert into ops.breaker_state (provider, account)
  values (p_provider, p_account)
  on conflict (provider, account) do nothing;
  select * into v_row from ops.breaker_state b
   where b.provider = p_provider and b.account = p_account
     for update;
  -- The same reading breaker_record makes: a probe out decides, an open window keeps it open.
  v_previous := case
    when v_row.probe_until is not null then 'half_open'
    when v_row.open_until is not null then 'open'
    else 'closed'
  end;
  return query
    select ops.breaker_record(p_provider, p_account, p_failure, p_min_calls, p_ratio, p_open_ms),
           v_previous;
end;
$$;
