-- Records money a provider already charged, with no reservation behind it: a charge found after
-- its poster died once its reservation had been released. Caps decide new reservations, not
-- spending that already happened, so nothing here can refuse it; it still counts on every scope,
-- so later reservations see it.
create function ops.record_incurred_spend(
  p_day date, p_scopes text[], p_caps bigint[], p_amount bigint, p_ledger jsonb
)
  returns table (ledger_id uuid, scopes text[], used bigint[], caps bigint[])
  language plpgsql
  security invoker
  set search_path = pg_catalog, ops, app, pg_temp
as $$
#variable_conflict use_column
declare
  v_currency app.currency_code := p_ledger ->> 'currency';
  v_id uuid;
begin
  if p_day is null or (p_amount >= 0) is not true or v_currency is null
     or (cardinality(p_scopes) >= 1) is not true
     or cardinality(p_scopes) is distinct from cardinality(p_caps)
     or array_position(p_scopes, null) is not null
     or (select count(distinct s) from unnest(p_scopes) s) <> cardinality(p_scopes)
     or exists (select from unnest(p_caps) c where (c >= 0) is not true) then
    raise exception 'record_incurred_spend needs a currency and distinct scopes with non-negative caps'
      using errcode = 'invalid_parameter_value';
  end if;
  if (select min(s) from unnest(p_scopes) s) is distinct from 'global' then
    raise exception 'record_incurred_spend needs the global scope, and no scope that sorts before it'
      using errcode = 'invalid_parameter_value';
  end if;

  perform ops.lock_spend_day(p_day);

  insert into ops.spend_counters as c
    (day, scope, cap_amount_micros, cap_currency, used_amount_micros, used_currency)
  select p_day, s.scope, s.cap, v_currency, 0, v_currency
    from unnest(p_scopes, p_caps) s (scope, cap)
   order by s.scope
  on conflict (day, scope) do update
     set cap_amount_micros = excluded.cap_amount_micros
   where c.cap_amount_micros is distinct from excluded.cap_amount_micros;
  if exists (select from ops.spend_counters c
              where c.day = p_day and c.scope = any (p_scopes)
                and (c.cap_currency <> v_currency or c.used_currency <> v_currency)) then
    raise exception 'record_incurred_spend got a currency other than the one its counters hold'
      using errcode = 'invalid_parameter_value';
  end if;

  update ops.spend_counters c
     set used_amount_micros = c.used_amount_micros + p_amount
   where c.day = p_day and c.scope = any (p_scopes);
  insert into ops.spend_ledger
    (day, provider, channel, engine, purpose, pool, scopes, ref_type, ref_id,
     reserved_amount_micros, reserved_currency, actual_amount_micros, actual_currency, status,
     settled_at)
  values
    (p_day, p_ledger ->> 'provider', p_ledger ->> 'channel', p_ledger ->> 'engine',
     p_ledger ->> 'purpose', p_ledger ->> 'pool', p_scopes, p_ledger ->> 'ref_type',
     p_ledger ->> 'ref_id', p_amount, v_currency, p_amount, v_currency, 'settled',
     clock_timestamp())
  returning id into v_id;

  return query
    select v_id, p_scopes,
           array(select c.used_amount_micros::bigint
                   from unnest(p_scopes) with ordinality s (scope, n)
                   join ops.spend_counters c on c.day = p_day and c.scope = s.scope
                  order by s.n),
           array(select c.cap_amount_micros::bigint
                   from unnest(p_scopes) with ordinality s (scope, n)
                   join ops.spend_counters c on c.day = p_day and c.scope = s.scope
                  order by s.n);
end;
$$;
