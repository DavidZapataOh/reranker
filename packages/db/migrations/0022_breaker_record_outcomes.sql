-- Counts a batch of call outcomes in one transaction on the breaker row: an instance records the
-- outcomes that arrived while its previous record was in flight together. breaker_record and
-- breaker_record_transition stay for instances still running the previous release; all three
-- lock the same breaker_state row, so a mixed fleet counts every outcome once.
create function ops.breaker_record_outcomes(
  p_provider text, p_account text, p_successes int, p_failures int,
  p_min_calls int, p_ratio float8, p_open_ms int
)
  returns table (state text, previous text)
  language plpgsql
  security invoker
  set search_path = pg_catalog, ops, app, pg_temp
as $$
#variable_conflict use_column
declare
  v_now timestamptz;
  v_row ops.breaker_state;
  v_previous text;
  v_bucket timestamptz;
  v_calls bigint;
  v_failures bigint;
begin
  if (p_successes >= 0 and p_failures >= 0 and p_successes + p_failures >= 1
      and p_min_calls >= 1 and p_ratio > 0 and p_ratio <= 1 and p_open_ms >= 1) is not true then
    raise exception 'breaker_record_outcomes needs at least one outcome, at least one call, a ratio in (0, 1] and a positive open window'
      using errcode = 'invalid_parameter_value';
  end if;
  insert into ops.breaker_state (provider, account)
  values (p_provider, p_account)
  on conflict (provider, account) do nothing;
  select * into v_row from ops.breaker_state b
   where b.provider = p_provider and b.account = p_account
     for update;
  v_now := clock_timestamp();
  v_previous := case
    when v_row.probe_until is not null then 'half_open'
    when v_row.open_until is not null then 'open'
    else 'closed'
  end;

  -- While a probe is out, any failure among the outcomes reopens, as one failed probe would.
  if v_row.probe_until is not null then
    if p_failures > 0 then
      update ops.breaker_state b
         set open_until = v_now + p_open_ms * interval '1 millisecond', probe_until = null
       where b.provider = p_provider and b.account = p_account;
      return query select 'open'::text, v_previous;
      return;
    end if;
    update ops.breaker_state b
       set open_until = null, probe_until = null, opened_at = null
     where b.provider = p_provider and b.account = p_account;
    delete from ops.breaker_windows w where w.provider = p_provider and w.account = p_account;
    return query select 'closed'::text, v_previous;
    return;
  end if;
  if v_row.open_until is not null then
    return query select 'open'::text, v_previous;
    return;
  end if;

  v_bucket := date_bin('10 seconds', v_now, timestamptz '1970-01-01 00:00:00+00');
  delete from ops.breaker_windows w
   where w.provider = p_provider and w.account = p_account
     and w.bucket_start <= v_bucket - interval '60 seconds';
  insert into ops.breaker_windows as w (provider, account, bucket_start, calls, failures)
  values (p_provider, p_account, v_bucket, p_successes + p_failures, p_failures)
  on conflict (provider, account, bucket_start) do update
     set calls = w.calls + excluded.calls, failures = w.failures + excluded.failures;
  select sum(w.calls), sum(w.failures) into v_calls, v_failures
    from ops.breaker_windows w
   where w.provider = p_provider and w.account = p_account
     and w.bucket_start > v_bucket - interval '60 seconds';

  if v_calls >= p_min_calls and v_failures >= p_ratio * v_calls then
    update ops.breaker_state b
       set open_until = v_now + p_open_ms * interval '1 millisecond', opened_at = v_now
     where b.provider = p_provider and b.account = p_account;
    return query select 'open'::text, v_previous;
    return;
  end if;
  return query select 'closed'::text, v_previous;
end;
$$;
