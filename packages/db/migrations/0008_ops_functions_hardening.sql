-- Custom SQL migration file, put your code below! --
-- Every ops function runs with a pinned search_path, so a caller's search_path can never make a
-- builtin or an operator resolve to an object of another schema.
--
-- Behaviour kept on purpose:
-- * reserve_spend: when the pool is short and its fallback is short too, the denial names the
--   fallback pool (or a later scope), and `scopes` lists the fallback in the pool's place.
-- * breaker_record: while a probe is out, the next outcome recorded decides, whichever call it
--   comes from; a call admitted before the breaker opened can close or reopen it in the probe's
--   place. Outcomes are not tied to the call that claimed the probe.

-- A missing bucket starts full. Nothing is taken unless every bucket has enough tokens; a bucket
-- deleted between the insert and the lock counts as empty, so the caller retries at once and
-- finds it full again.
create or replace function ops.take_tokens(p_keys text[], p_caps float8[], p_refills float8[], p_costs float8[])
  returns table (ok boolean, remaining float8[], retry_after_ms int)
  language plpgsql
  security invoker
  set search_path = pg_catalog, ops, app, pg_temp
as $$
#variable_conflict use_column
declare
  v_now timestamptz;
  v_ok boolean;
  v_levels float8[];
  v_wait_s float8;
begin
  if cardinality(p_keys) is null
     or cardinality(p_keys) is distinct from cardinality(p_caps)
     or cardinality(p_keys) is distinct from cardinality(p_refills)
     or cardinality(p_keys) is distinct from cardinality(p_costs)
     or (select count(distinct k) from unnest(p_keys) k) <> cardinality(p_keys)
     or exists (select from unnest(p_caps, p_refills, p_costs) b (cap, refill, cost)
                 where (b.cap > 0 and b.refill > 0 and b.cost >= 0 and b.cost <= b.cap) is not true) then
    raise exception 'take_tokens needs distinct keys, each with a positive cap and refill and a cost between zero and its cap'
      using errcode = 'invalid_parameter_value';
  end if;
  if cardinality(p_keys) = 0 then
    return query select true, '{}'::float8[], 0;
    return;
  end if;

  insert into ops.rate_buckets (key, tokens, updated_at)
  select b.key, b.cap, clock_timestamp()
    from unnest(p_keys, p_caps) b (key, cap)
   order by b.key
  on conflict (key) do nothing;
  perform 1 from ops.rate_buckets r where r.key = any (p_keys) order by r.key for update;
  v_now := clock_timestamp();

  select bool_and(coalesce(x.level >= x.cost, false)),
         array_agg(x.level order by x.ord),
         max((x.cost - x.level) / x.refill) filter (where x.level < x.cost)
    into v_ok, v_levels, v_wait_s
    from (select b.ord, b.cost, b.refill,
                 case when r.key is not null then
                   least(b.cap, r.tokens
                     + greatest(0, extract(epoch from v_now - r.updated_at))::float8 * b.refill)
                 end as level
            from unnest(p_keys, p_caps, p_refills, p_costs) with ordinality b (key, cap, refill, cost, ord)
            left join ops.rate_buckets r on r.key = b.key) x;

  if v_ok is not true then
    return query
      select false, v_levels, least(greatest(1, ceil(coalesce(v_wait_s, 0) * 1000)), 2147483647)::int;
    return;
  end if;

  update ops.rate_buckets r
     set tokens = b.level - b.cost, updated_at = v_now
    from unnest(p_keys, v_levels, p_costs) b (key, level, cost)
   where r.key = b.key;
  return query
    select true, array(select u.level - u.cost
                         from unnest(v_levels, p_costs) with ordinality u (level, cost, ord)
                        order by u.ord), 0;
end;
$$;
--> statement-breakpoint
-- Releases reservations of a day older than p_older_than (the function that made them died
-- before settling). SKIP LOCKED leaves a reservation that is being settled to its settle. The
-- window is at least 15 minutes, longer than any step holds a reservation: a shorter one would
-- release a reservation still in use, and its settle would then count nothing.
create or replace function ops.release_stale_reservations(p_day date, p_older_than interval)
  returns int
  language plpgsql
  security invoker
  set search_path = pg_catalog, ops, app, pg_temp
as $$
declare
  v_count int;
  v_scopes text[];
  v_amounts bigint[];
begin
  if p_day is null or (p_older_than >= interval '15 minutes') is not true then
    raise exception 'release_stale_reservations needs a day and a window of at least 15 minutes'
      using errcode = 'invalid_parameter_value';
  end if;
  with released as (
    update ops.spend_ledger l
       set status = 'released', settled_at = clock_timestamp()
     where l.id in (select s.id
                      from ops.spend_ledger s
                     where s.day = p_day and s.status = 'reserved'
                       and s.created_at < clock_timestamp() - p_older_than
                       for update skip locked)
    returning l.scopes, l.reserved_amount_micros
  ), per_scope as (
    select x.scope, sum(r.reserved_amount_micros)::bigint as amount
      from released r
     cross join unnest(r.scopes) x (scope)
     group by x.scope
  )
  select (select count(*) from released), array_agg(p.scope order by p.scope),
         array_agg(p.amount order by p.scope)
    into v_count, v_scopes, v_amounts
    from per_scope p;
  if v_count = 0 then
    return 0;
  end if;

  perform 1 from ops.spend_counters c
   where c.day = p_day and c.scope = any (v_scopes)
   order by c.scope
     for update;
  update ops.spend_counters c
     set used_amount_micros = c.used_amount_micros - a.amount
    from unnest(v_scopes, v_amounts) a (scope, amount)
   where c.day = p_day and c.scope = a.scope;
  return v_count;
end;
$$;
--> statement-breakpoint
-- Charges p_amount to every scope, or to none. When the pool scope ('pool:' || ledger pool) is the
-- only one short and a fallback pool is given, the fallback takes its place. When a cap still
-- looks exhausted, stale reservations are released once and the reservation is tried again.
-- p_ledger carries provider, channel, engine, purpose, pool, ref_type, ref_id and currency.
-- Returns the ledger id, or null with the first denied scope in the caller's order, plus the
-- scopes tried and their used and cap after the call.
--
-- Lock order: every scope set includes 'global', and no scope sorts before it ('pool:',
-- 'provider:' and 'purpose:' all come after), so the first counter any spend function locks on a
-- day is that day's global row. Reservations, settles and releases of one day queue there and
-- can never hold two counters in opposite orders.
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
-- Adds one request to the current minute and returns the ten-minute and one-hour windows (the
-- current minute plus the 9 or 59 before it). Spend is the estimated provider cost admitted, in
-- USD micros like every spend cap.
create or replace function ops.record_velocity(p_key text, p_flagged boolean, p_spend bigint)
  returns table (count10m int, flagged10m int, spend10m bigint, spend60m bigint)
  language plpgsql
  security invoker
  set search_path = pg_catalog, ops, app, pg_temp
as $$
#variable_conflict use_column
declare
  v_bucket timestamptz := date_bin('1 minute', clock_timestamp(), timestamptz '1970-01-01 00:00:00+00');
begin
  if p_key is null or p_flagged is null or (p_spend >= 0) is not true then
    raise exception 'record_velocity needs a key, a flag and a non-negative spend'
      using errcode = 'invalid_parameter_value';
  end if;
  insert into ops.velocity_buckets as v (key, bucket_start, count, flagged, spend_amount_micros, spend_currency)
  values (p_key, v_bucket, 1, p_flagged::int, p_spend, 'USD')
  on conflict (key, bucket_start) do update
     set count = v.count + 1,
         flagged = v.flagged + excluded.flagged,
         spend_amount_micros = v.spend_amount_micros + excluded.spend_amount_micros;
  return query
    select coalesce(sum(v.count) filter (where v.bucket_start > v_bucket - interval '10 minutes'), 0)::int,
           coalesce(sum(v.flagged) filter (where v.bucket_start > v_bucket - interval '10 minutes'), 0)::int,
           coalesce(sum(v.spend_amount_micros) filter (where v.bucket_start > v_bucket - interval '10 minutes'), 0)::bigint,
           coalesce(sum(v.spend_amount_micros), 0)::bigint
      from ops.velocity_buckets v
     where v.key = p_key and v.bucket_start > v_bucket - interval '60 minutes';
end;
$$;
--> statement-breakpoint
alter function ops.peek_tokens(text, float8, float8) set search_path = pg_catalog, ops, app, pg_temp;
--> statement-breakpoint
alter function ops.refund_tokens(text, float8, float8, float8) set search_path = pg_catalog, ops, app, pg_temp;
--> statement-breakpoint
alter function ops.acquire_slot(text, int, int, text[], float8[], float8[], float8[])
  set search_path = pg_catalog, ops, app, pg_temp;
--> statement-breakpoint
alter function ops.settle_spend(uuid, bigint) set search_path = pg_catalog, ops, app, pg_temp;
--> statement-breakpoint
alter function ops.release_spend(uuid) set search_path = pg_catalog, ops, app, pg_temp;
--> statement-breakpoint
alter function ops.breaker_check(text, text, int) set search_path = pg_catalog, ops, app, pg_temp;
--> statement-breakpoint
alter function ops.breaker_record(text, text, boolean, int, float8, int)
  set search_path = pg_catalog, ops, app, pg_temp;
--> statement-breakpoint
alter function ops.trip_guard_mode(text, text, int) set search_path = pg_catalog, ops, app, pg_temp;
--> statement-breakpoint
alter function ops.guard_mode_status(text) set search_path = pg_catalog, ops, app, pg_temp;
--> statement-breakpoint
alter function ops.consume_quota(date, text, text, int, int) set search_path = pg_catalog, ops, app, pg_temp;
--> statement-breakpoint
-- Per-schema default privileges only add to the global ones, and the global default grants
-- EXECUTE on functions to PUBLIC, so the revoke has to be global. New ops functions then reach
-- app_system the way new ops tables do.
alter default privileges for role reranker_owner revoke execute on functions from public;
--> statement-breakpoint
alter default privileges for role reranker_owner in schema ops grant execute on functions to app_system;
