-- Custom SQL migration file, put your code below! --
-- Each function is one whole admission, spend, breaker or quota decision. Callers run it as the
-- only statement of a withSystem transaction, so its row locks end at that commit. Rows are
-- locked in key order, so concurrent callers queue instead of deadlocking. Validation errors use
-- SQLSTATE 22023 (invalid_parameter_value). Functions returning a table use
-- `#variable_conflict use_column` because their output names match table columns.

-- A missing bucket starts full. Nothing is taken unless every bucket has enough tokens.
create function ops.take_tokens(p_keys text[], p_caps float8[], p_refills float8[], p_costs float8[])
  returns table (ok boolean, remaining float8[], retry_after_ms int)
  language plpgsql
  security invoker
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
                 where (b.cap > 0 and b.refill > 0 and b.cost >= 0) is not true) then
    raise exception 'take_tokens needs distinct keys, each with a positive cap and refill and a non-negative cost'
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

  select bool_and(x.level >= x.cost),
         array_agg(x.level order by x.ord),
         max((x.cost - x.level) / x.refill) filter (where x.level < x.cost)
    into v_ok, v_levels, v_wait_s
    from (select b.ord, b.cost, b.refill,
                 least(b.cap, r.tokens
                   + greatest(0, extract(epoch from v_now - r.updated_at))::float8 * b.refill) as level
            from unnest(p_keys, p_caps, p_refills, p_costs) with ordinality b (key, cap, refill, cost, ord)
            join ops.rate_buckets r on r.key = b.key) x;

  if not v_ok then
    return query select false, v_levels, least(ceil(v_wait_s * 1000), 2147483647)::int;
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
-- Read only: the balance and the wait until one token (or the whole cap, if smaller) is there.
create function ops.peek_tokens(p_key text, p_cap float8, p_refill float8)
  returns table (remaining float8, retry_after_ms int)
  language plpgsql
  security invoker
as $$
#variable_conflict use_column
declare
  v_level float8;
  v_unit float8 := least(1, p_cap);
begin
  if (p_cap > 0 and p_refill > 0) is not true then
    raise exception 'peek_tokens needs a positive cap and refill' using errcode = 'invalid_parameter_value';
  end if;
  select least(p_cap, r.tokens
           + greatest(0, extract(epoch from clock_timestamp() - r.updated_at))::float8 * p_refill)
    into v_level
    from ops.rate_buckets r
   where r.key = p_key;
  v_level := coalesce(v_level, p_cap);
  return query
    select v_level,
           case when v_level >= v_unit then 0
                else least(ceil((v_unit - v_level) / p_refill * 1000), 2147483647)::int end;
end;
$$;
--> statement-breakpoint
-- Gives tokens back after an admission that did no work, never above the cap.
create function ops.refund_tokens(p_key text, p_cap float8, p_refill float8, p_cost float8)
  returns void
  language plpgsql
  security invoker
as $$
begin
  if (p_cap > 0 and p_refill > 0 and p_cost >= 0) is not true then
    raise exception 'refund_tokens needs a positive cap and refill and a non-negative cost'
      using errcode = 'invalid_parameter_value';
  end if;
  insert into ops.rate_buckets as r (key, tokens, updated_at)
  values (p_key, p_cap, clock_timestamp())
  on conflict (key) do update
     set tokens = least(p_cap, r.tokens
           + greatest(0, extract(epoch from excluded.updated_at - r.updated_at))::float8 * p_refill
           + p_cost),
         updated_at = excluded.updated_at;
end;
$$;
--> statement-breakpoint
-- The pool row is the lock that serializes acquisitions of one provider account. Expired leases
-- (functions that died holding a slot) are deleted on the way. The rate buckets are taken only
-- when a slot is free, so a denied slot never spends tokens.
create function ops.acquire_slot(
  p_key text, p_limit int, p_ttl_ms int,
  p_bucket_keys text[], p_caps float8[], p_refills float8[], p_costs float8[]
)
  returns table (lease_id uuid, retry_after_ms int)
  language plpgsql
  security invoker
as $$
#variable_conflict use_column
declare
  v_now timestamptz;
  v_live int;
  v_next timestamptz;
  v_tokens record;
  v_lease uuid;
begin
  if p_key is null or (p_limit >= 1 and p_ttl_ms >= 1) is not true then
    raise exception 'acquire_slot needs a key, a limit of at least 1 and a positive ttl'
      using errcode = 'invalid_parameter_value';
  end if;
  -- ON CONFLICT DO UPDATE locks the row even when its WHERE skips the write.
  insert into ops.lease_pools as p (key, max_in_flight)
  values (p_key, p_limit)
  on conflict (key) do update
     set max_in_flight = excluded.max_in_flight
   where p.max_in_flight is distinct from excluded.max_in_flight;
  v_now := clock_timestamp();

  delete from ops.concurrency_leases l where l.key = p_key and l.expires_at <= v_now;
  select count(*), min(l.expires_at) into v_live, v_next
    from ops.concurrency_leases l
   where l.key = p_key;
  if v_live >= p_limit then
    return query
      select null::uuid, greatest(1, ceil(extract(epoch from v_next - v_now) * 1000))::int;
    return;
  end if;

  select * into v_tokens from ops.take_tokens(p_bucket_keys, p_caps, p_refills, p_costs);
  if not v_tokens.ok then
    return query select null::uuid, v_tokens.retry_after_ms;
    return;
  end if;

  insert into ops.concurrency_leases (key, expires_at)
  values (p_key, v_now + p_ttl_ms * interval '1 millisecond')
  returning lease_id into v_lease;
  return query select v_lease, 0;
end;
$$;
--> statement-breakpoint
-- Releases reservations of a day older than p_older_than (the function that made them died
-- before settling). SKIP LOCKED leaves a reservation that is being settled to its settle.
create function ops.release_stale_reservations(p_day date, p_older_than interval)
  returns int
  language plpgsql
  security invoker
as $$
declare
  v_count int;
  v_scopes text[];
  v_amounts bigint[];
begin
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
create function ops.reserve_spend(
  p_day date, p_scopes text[], p_caps bigint[], p_fallback_scope text, p_fallback_cap bigint,
  p_amount bigint, p_ledger jsonb
)
  returns table (ledger_id uuid, denied_scope text, scopes text[], used bigint[], caps bigint[])
  language plpgsql
  security invoker
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
  if p_day is null or (p_amount >= 0) is not true
     or (cardinality(p_scopes) >= 1) is not true
     or cardinality(p_scopes) is distinct from cardinality(p_caps)
     or (select count(distinct s) from unnest(p_scopes) s) <> cardinality(p_scopes)
     or exists (select from unnest(p_caps) c where (c >= 0) is not true)
     or (p_fallback_scope is null) <> (p_fallback_cap is null)
     or (p_fallback_scope is not null
         and (v_pool_scope = any (p_scopes) and p_fallback_scope like 'pool:_%'
              and p_fallback_scope <> all (p_scopes) and p_fallback_cap >= 0) is not true) then
    raise exception 'reserve_spend needs distinct scopes with non-negative caps, and a fallback pool only beside the reservation''s own pool'
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
-- Records the real cost against the reservation's own day and scopes, even past the cap: money
-- already spent is counted. False when the reservation was already settled or released, so a
-- retried step never adjusts twice.
create function ops.settle_spend(p_ledger_id uuid, p_actual bigint)
  returns boolean
  language plpgsql
  security invoker
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
-- Gives the whole reservation back when the provider charged nothing; idempotent like settle.
create function ops.release_spend(p_ledger_id uuid)
  returns boolean
  language plpgsql
  security invoker
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
--> statement-breakpoint
-- Closed and open answers read without locking. Once the open window is over, the first caller
-- claims the probe (half_open) and everyone else waits for its outcome; a probe that never
-- reports back is handed out again after p_probe_ms.
create function ops.breaker_check(p_provider text, p_account text, p_probe_ms int)
  returns table (state text, retry_after_ms int, opened_at timestamptz)
  language plpgsql
  security invoker
as $$
#variable_conflict use_column
declare
  v_now timestamptz := clock_timestamp();
  v_row ops.breaker_state;
begin
  if (p_probe_ms >= 1) is not true then
    raise exception 'breaker_check needs a positive probe window' using errcode = 'invalid_parameter_value';
  end if;
  select * into v_row from ops.breaker_state b where b.provider = p_provider and b.account = p_account;
  if v_row.open_until is null then
    return query select 'closed', 0, null::timestamptz;
    return;
  end if;
  if v_row.open_until > v_now then
    return query
      select 'open', ceil(extract(epoch from v_row.open_until - v_now) * 1000)::int, v_row.opened_at;
    return;
  end if;

  update ops.breaker_state b
     set probe_until = v_now + p_probe_ms * interval '1 millisecond'
   where b.provider = p_provider and b.account = p_account and b.open_until <= v_now
     and (b.probe_until is null or b.probe_until <= v_now)
  returning b.opened_at into v_row.opened_at;
  if found then
    return query select 'half_open', 0, v_row.opened_at;
    return;
  end if;

  -- Another caller claimed the probe after this one started, so the wait counts from now.
  v_now := clock_timestamp();
  select * into v_row from ops.breaker_state b where b.provider = p_provider and b.account = p_account;
  if v_row.open_until is null then
    return query select 'closed', 0, null::timestamptz;
    return;
  end if;
  return query
    select 'open',
           greatest(1, ceil(extract(epoch from greatest(v_row.open_until, v_row.probe_until) - v_now) * 1000))::int,
           v_row.opened_at;
end;
$$;
--> statement-breakpoint
-- Counts outcomes in ten-second buckets and opens when the last minute has at least p_min_calls
-- calls and a failure ratio of at least p_ratio. While a probe is out, the next outcome decides:
-- a failure reopens for p_open_ms keeping opened_at, a success closes and forgets the window.
-- Outcomes of calls made before the breaker opened do not move it. Returns the state after.
create function ops.breaker_record(
  p_provider text, p_account text, p_failure boolean, p_min_calls int, p_ratio float8, p_open_ms int
)
  returns text
  language plpgsql
  security invoker
as $$
declare
  v_now timestamptz;
  v_row ops.breaker_state;
  v_bucket timestamptz;
  v_calls bigint;
  v_failures bigint;
begin
  if p_failure is null or (p_min_calls >= 1 and p_ratio > 0 and p_ratio <= 1 and p_open_ms >= 1) is not true then
    raise exception 'breaker_record needs an outcome, at least one call, a ratio in (0, 1] and a positive open window'
      using errcode = 'invalid_parameter_value';
  end if;
  insert into ops.breaker_state (provider, account)
  values (p_provider, p_account)
  on conflict (provider, account) do nothing;
  select * into v_row from ops.breaker_state b
   where b.provider = p_provider and b.account = p_account
     for update;
  v_now := clock_timestamp();

  if v_row.probe_until is not null then
    if p_failure then
      update ops.breaker_state b
         set open_until = v_now + p_open_ms * interval '1 millisecond', probe_until = null
       where b.provider = p_provider and b.account = p_account;
      return 'open';
    end if;
    update ops.breaker_state b
       set open_until = null, probe_until = null, opened_at = null
     where b.provider = p_provider and b.account = p_account;
    delete from ops.breaker_windows w where w.provider = p_provider and w.account = p_account;
    return 'closed';
  end if;
  if v_row.open_until is not null then
    return 'open';
  end if;

  v_bucket := date_bin('10 seconds', v_now, timestamptz '1970-01-01 00:00:00+00');
  delete from ops.breaker_windows w
   where w.provider = p_provider and w.account = p_account
     and w.bucket_start <= v_bucket - interval '60 seconds';
  insert into ops.breaker_windows as w (provider, account, bucket_start, calls, failures)
  values (p_provider, p_account, v_bucket, 1, p_failure::int)
  on conflict (provider, account, bucket_start) do update
     set calls = w.calls + 1, failures = w.failures + excluded.failures;
  select sum(w.calls), sum(w.failures) into v_calls, v_failures
    from ops.breaker_windows w
   where w.provider = p_provider and w.account = p_account
     and w.bucket_start > v_bucket - interval '60 seconds';

  if v_calls >= p_min_calls and v_failures >= p_ratio * v_calls then
    update ops.breaker_state b
       set open_until = v_now + p_open_ms * interval '1 millisecond', opened_at = v_now
     where b.provider = p_provider and b.account = p_account;
    return 'open';
  end if;
  return 'closed';
end;
$$;
--> statement-breakpoint
-- Adds one request to the current minute and returns the ten-minute and one-hour windows (the
-- current minute plus the 9 or 59 before it). Spend is the estimated provider cost admitted, in
-- USD micros like every spend cap.
create function ops.record_velocity(p_key text, p_flagged boolean, p_spend bigint)
  returns table (count10m int, flagged10m int, spend10m bigint, spend60m bigint)
  language plpgsql
  security invoker
as $$
#variable_conflict use_column
declare
  v_bucket timestamptz := date_bin('1 minute', clock_timestamp(), timestamptz '1970-01-01 00:00:00+00');
begin
  if p_key is null or p_flagged is null then
    raise exception 'record_velocity needs a key and a flag' using errcode = 'invalid_parameter_value';
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
-- Trips a guard mode for p_hold_ms, or extends one already active (never shortens it).
-- newly_tripped is true only for the call that turned it on.
create function ops.trip_guard_mode(p_name text, p_reason text, p_hold_ms int)
  returns table (active_until timestamptz, newly_tripped boolean)
  language plpgsql
  security invoker
as $$
#variable_conflict use_column
declare
  v_now timestamptz := clock_timestamp();
  v_until timestamptz;
  v_row ops.guard_modes;
begin
  if p_name is null or p_reason is null or (p_hold_ms >= 1) is not true then
    raise exception 'trip_guard_mode needs a name, a reason and a positive hold' using errcode = 'invalid_parameter_value';
  end if;
  v_until := v_now + p_hold_ms * interval '1 millisecond';
  insert into ops.guard_modes (name, active_until, tripped_at, reason)
  values (p_name, v_until, v_now, p_reason)
  on conflict (name) do nothing;
  if found then
    return query select v_until, true;
    return;
  end if;

  select * into v_row from ops.guard_modes g where g.name = p_name for update;
  if v_row.released_at is null and v_row.active_until > v_now then
    update ops.guard_modes g
       set active_until = greatest(g.active_until, v_until)
     where g.name = p_name
    returning g.active_until into v_until;
    return query select v_until, false;
    return;
  end if;
  update ops.guard_modes g
     set active_until = v_until, tripped_at = v_now, reason = p_reason, released_at = null
   where g.name = p_name;
  return query select v_until, true;
end;
$$;
--> statement-breakpoint
-- Reads a guard mode and, in the same statement, marks an expired one released; released_now is
-- true for exactly one caller, the one that should announce the release.
create function ops.guard_mode_status(p_name text)
  returns table (active boolean, active_until timestamptz, reason text, released_now boolean)
  language plpgsql
  security invoker
as $$
#variable_conflict use_column
declare
  v_now timestamptz := clock_timestamp();
begin
  return query
    with released as (
      update ops.guard_modes g
         set released_at = v_now
       where g.name = p_name and g.active_until <= v_now and g.released_at is null
      returning g.name
    )
    select g.released_at is null and coalesce(g.active_until > v_now, false),
           g.active_until, g.reason, exists (select from released)
      from ops.guard_modes g
     where g.name = p_name;
  if not found then
    return query select false, null::timestamptz, null::text, false;
  end if;
end;
$$;
--> statement-breakpoint
-- Takes p_amount from one priority's fixed daily allocation; false when it would pass p_limit.
create function ops.consume_quota(p_day date, p_name text, p_priority text, p_amount int, p_limit int)
  returns boolean
  language plpgsql
  security invoker
as $$
begin
  if p_day is null or p_name is null or (p_amount >= 1 and p_limit >= 0) is not true then
    raise exception 'consume_quota needs a day, a name, a positive amount and a non-negative limit'
      using errcode = 'invalid_parameter_value';
  end if;
  insert into ops.quota_counters as q (day, name, priority, used)
  select p_day, p_name, p_priority, p_amount
   where p_amount <= p_limit
  on conflict (day, name, priority) do update
     set used = q.used + excluded.used
   where q.used + excluded.used <= p_limit;
  return found;
end;
$$;
--> statement-breakpoint
-- Functions are executable by PUBLIC by default; only the system runtime role may call these.
revoke all on all functions in schema ops from public;
--> statement-breakpoint
grant execute on all functions in schema ops to app_system;
