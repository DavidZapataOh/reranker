-- Reserving, settling and releasing take the day's lock before any of its counter rows, so they
-- queue in arrival order. On the counter rows alone they do not: a waiter whose row was updated
-- meanwhile has to lock the new version and races every later arrival for it, so under load the
-- oldest waiter can keep losing until its statement times out while newer ones pass. The daily
-- reconciliation's release of stale reservations stays off this queue: it skips the ledger rows a
-- settle holds instead of waiting behind it.
-- The two-key form keeps these locks apart from every single-key advisory lock.
create function ops.lock_spend_day(p_day date)
  returns void
  language sql
  security invoker
  set search_path = pg_catalog, ops, app, pg_temp
as $$
  select pg_advisory_xact_lock(hashtext('ops.spend_counters'), p_day - date '2000-01-01');
$$;
--> statement-breakpoint
-- Lock order: the day lock, then the counters in scope order, global first. Settles and releases
-- claim their ledger row before the day lock, which cannot deadlock: a reservation takes ledger
-- rows only through release_stale_reservations, with SKIP LOCKED.
create or replace function ops.reserve_spend(
  p_day date, p_scopes text[], p_caps bigint[], p_fallback_scope text, p_fallback_cap bigint,
  p_amount bigint, p_ledger jsonb
)
  returns table (ledger_id uuid, denied_scope text, scopes text[], used bigint[], caps bigint[])
  language plpgsql
  security invoker
  set search_path = pg_catalog, ops, app, pg_temp
as $$
#variable_conflict use_column
declare
  v_currency app.currency_code := p_ledger ->> 'currency';
  v_pool_scope text := 'pool:' || (p_ledger ->> 'pool');
  v_scopes text[];
  v_denied text[];
  v_fallback boolean;
  v_id uuid;
begin
  if p_day is null or (p_amount >= 0) is not true or v_currency is null
     or (cardinality(p_scopes) >= 1) is not true
     or cardinality(p_scopes) is distinct from cardinality(p_caps)
     or array_position(p_scopes, null) is not null
     or (select count(distinct s) from unnest(p_scopes) s) <> cardinality(p_scopes)
     or exists (select from unnest(p_caps) c where (c >= 0) is not true)
     or (p_fallback_scope is null) <> (p_fallback_cap is null)
     or (p_fallback_scope is not null
         and (v_pool_scope = any (p_scopes) and p_fallback_scope like 'pool:_%'
              and p_fallback_scope <> all (p_scopes) and p_fallback_cap >= 0) is not true) then
    raise exception 'reserve_spend needs a currency, distinct scopes with non-negative caps, and a fallback pool only beside the reservation''s own pool'
      using errcode = 'invalid_parameter_value';
  end if;
  if (select min(s) from unnest(p_scopes) s) is distinct from 'global' then
    raise exception 'reserve_spend needs the global scope, and no scope that sorts before it'
      using errcode = 'invalid_parameter_value';
  end if;

  perform ops.lock_spend_day(p_day);

  -- Creates or locks every counter this reservation may charge, in scope order. The cap is
  -- refreshed so a changed limit applies from the next reservation on.
  insert into ops.spend_counters as c
    (day, scope, cap_amount_micros, cap_currency, used_amount_micros, used_currency)
  select p_day, s.scope, s.cap, v_currency, 0, v_currency
    from unnest(p_scopes || p_fallback_scope, p_caps || p_fallback_cap) s (scope, cap)
   where s.scope is not null
   order by s.scope
  on conflict (day, scope) do update
     set cap_amount_micros = excluded.cap_amount_micros
   where c.cap_amount_micros is distinct from excluded.cap_amount_micros;
  if exists (select from ops.spend_counters c
              where c.day = p_day and c.scope = any (p_scopes || p_fallback_scope)
                and (c.cap_currency <> v_currency or c.used_currency <> v_currency)) then
    raise exception 'reserve_spend got a currency other than the one its counters hold'
      using errcode = 'invalid_parameter_value';
  end if;

  for v_pass in 1..2 loop
    v_scopes := p_scopes;
    v_fallback := false;
    loop
      select array_agg(c.scope order by array_position(v_scopes, c.scope)) into v_denied
        from ops.spend_counters c
       where c.day = p_day and c.scope = any (v_scopes)
         and c.used_amount_micros + p_amount > c.cap_amount_micros;
      exit when v_denied is null or v_fallback or p_fallback_scope is null
        or v_denied is distinct from array[v_pool_scope];
      v_scopes := array_replace(v_scopes, v_pool_scope, p_fallback_scope);
      v_fallback := true;
    end loop;
    exit when v_denied is null or v_pass = 2;
    -- Only when a cap looks exhausted, so the common path never touches the ledger.
    if ops.release_stale_reservations(p_day, interval '15 minutes') = 0 then
      exit;
    end if;
  end loop;

  if v_denied is null then
    update ops.spend_counters c
       set used_amount_micros = c.used_amount_micros + p_amount
     where c.day = p_day and c.scope = any (v_scopes);
    insert into ops.spend_ledger
      (day, provider, channel, engine, purpose, pool, scopes, ref_type, ref_id,
       reserved_amount_micros, reserved_currency, actual_currency)
    values
      (p_day, p_ledger ->> 'provider', p_ledger ->> 'channel', p_ledger ->> 'engine',
       p_ledger ->> 'purpose',
       case when v_fallback then substr(p_fallback_scope, length('pool:') + 1) else p_ledger ->> 'pool' end,
       v_scopes, p_ledger ->> 'ref_type', p_ledger ->> 'ref_id', p_amount, v_currency, v_currency)
    returning id into v_id;
  end if;

  return query
    select v_id, v_denied[1], v_scopes,
           array(select c.used_amount_micros::bigint
                   from unnest(v_scopes) with ordinality s (scope, n)
                   join ops.spend_counters c on c.day = p_day and c.scope = s.scope
                  order by s.n),
           array(select c.cap_amount_micros::bigint
                   from unnest(v_scopes) with ordinality s (scope, n)
                   join ops.spend_counters c on c.day = p_day and c.scope = s.scope
                  order by s.n);
end;
$$;
--> statement-breakpoint
create or replace function ops.settle_spend(p_ledger_id uuid, p_actual bigint)
  returns boolean
  language plpgsql
  security invoker
  set search_path = pg_catalog, ops, app, pg_temp
as $$
declare
  v_day date;
  v_scopes text[];
  v_reserved bigint;
begin
  if (p_actual >= 0) is not true then
    raise exception 'settle_spend needs a non-negative actual amount' using errcode = 'invalid_parameter_value';
  end if;
  update ops.spend_ledger l
     set status = 'settled', actual_amount_micros = p_actual, settled_at = clock_timestamp()
   where l.id = p_ledger_id and l.status = 'reserved'
  returning l.day, l.scopes, l.reserved_amount_micros into v_day, v_scopes, v_reserved;
  if not found then
    return false;
  end if;
  perform ops.lock_spend_day(v_day);
  perform 1 from ops.spend_counters c
   where c.day = v_day and c.scope = any (v_scopes)
   order by c.scope
     for update;
  update ops.spend_counters c
     set used_amount_micros = c.used_amount_micros - v_reserved + p_actual
   where c.day = v_day and c.scope = any (v_scopes);
  return true;
end;
$$;
--> statement-breakpoint
create or replace function ops.release_spend(p_ledger_id uuid)
  returns boolean
  language plpgsql
  security invoker
  set search_path = pg_catalog, ops, app, pg_temp
as $$
declare
  v_day date;
  v_scopes text[];
  v_reserved bigint;
begin
  update ops.spend_ledger l
     set status = 'released', settled_at = clock_timestamp()
   where l.id = p_ledger_id and l.status = 'reserved'
  returning l.day, l.scopes, l.reserved_amount_micros into v_day, v_scopes, v_reserved;
  if not found then
    return false;
  end if;
  perform ops.lock_spend_day(v_day);
  perform 1 from ops.spend_counters c
   where c.day = v_day and c.scope = any (v_scopes)
   order by c.scope
     for update;
  update ops.spend_counters c
     set used_amount_micros = c.used_amount_micros - v_reserved
   where c.day = v_day and c.scope = any (v_scopes);
  return true;
end;
$$;
