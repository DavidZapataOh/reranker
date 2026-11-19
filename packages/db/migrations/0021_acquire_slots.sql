-- One transaction on the pool row grants a whole queue of waiters and frees the leases released
-- since the last one. acquire_slot stays for instances still running the previous release.
create function ops.acquire_slots(
  p_key text, p_limit int, p_ttl_ms int, p_count int, p_released uuid[],
  p_bucket_keys text[], p_caps float8[], p_refills float8[], p_costs float8[]
)
  returns table (lease_id uuid, retry_after_ms int)
  language plpgsql
  security invoker
  set search_path = pg_catalog, ops, app, pg_temp
as $$
#variable_conflict use_column
declare
  v_buckets int := coalesce(cardinality(p_bucket_keys), 0);
  v_now timestamptz;
  v_live int;
  v_next timestamptz;
  v_tokens record;
  v_lease uuid;
  v_expires timestamptz;
begin
  if p_key is null or (p_limit >= 1 and p_ttl_ms >= 1 and p_count >= 0) is not true
     or cardinality(p_costs) is distinct from p_count * v_buckets then
    raise exception 'acquire_slots needs a key, a limit of at least 1, a positive ttl and one cost per bucket and request'
      using errcode = 'invalid_parameter_value';
  end if;
  -- Removing a lease only frees capacity, so it needs no lock on the pool.
  delete from ops.concurrency_leases l where l.lease_id = any (p_released) and l.key = p_key;
  if p_count = 0 then
    return;
  end if;
  -- ON CONFLICT DO UPDATE locks the row even when its WHERE skips the write.
  insert into ops.lease_pools as p (key, max_in_flight)
  values (p_key, p_limit)
  on conflict (key) do update
     set max_in_flight = excluded.max_in_flight
   where p.max_in_flight is distinct from excluded.max_in_flight;
  v_now := clock_timestamp();
  v_expires := v_now + p_ttl_ms * interval '1 millisecond';

  delete from ops.concurrency_leases l where l.key = p_key and l.expires_at <= v_now;
  select count(*), min(l.expires_at) into v_live, v_next
    from ops.concurrency_leases l
   where l.key = p_key;

  -- Requests are served in the order given and the first one denied ends the batch, so a later,
  -- cheaper request never passes an earlier one.
  for i in 1 .. p_count loop
    if v_live >= p_limit then
      return query
        select null::uuid, greatest(1, ceil(extract(epoch from v_next - v_now) * 1000))::int;
      return;
    end if;
    select * into v_tokens
      from ops.take_tokens(p_bucket_keys, p_caps, p_refills,
                           p_costs[(i - 1) * v_buckets + 1 : i * v_buckets]);
    if not v_tokens.ok then
      return query select null::uuid, v_tokens.retry_after_ms;
      return;
    end if;
    insert into ops.concurrency_leases (key, expires_at)
    values (p_key, v_expires)
    returning lease_id into v_lease;
    v_live := v_live + 1;
    v_next := least(v_next, v_expires);
    return query select v_lease, 0;
  end loop;
end;
$$;
