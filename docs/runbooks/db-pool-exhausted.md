# Database pool exhausted

## Trigger

The `db-pool-exhausted` alert (warning, source `db`). Each serverless instance counts its own connection timeouts and raises the alert only when one instance has more than 5 in 10 minutes, so a short burst never fires it. Each instance holds at most 5 connections for `reranker_app` and 3 for `reranker_system` unless `DB_POOL_MAX` overrides them, and waits 2 seconds for a free one.

## Impact

Requests that could not get a connection in 2 seconds failed with `service_unavailable` and a `Retry-After`; the customer retries. Requests that already hold a connection are unaffected. Nothing is lost or double-charged: a failed attempt did not run its transaction.

## Diagnose

A transaction held open too long is the usual cause; too many concurrent requests on one instance is the other. List what the database is doing, from the Neon console SQL editor of the affected project or with `psql` and the direct owner URL:

```sql
select pid, usename, state, now() - xact_start as age, left(query, 80) as query
from pg_stat_activity
where datname = current_database() and state <> 'idle'
order by xact_start;
```

- Rows with `state = 'idle in transaction'` or an `age` over 5 seconds: application code holds a transaction while it waits for something else, such as an HTTP call. Find the code path in the logs around the alert and move the wait outside `withTenant`.
- Many short rows at the same time: real concurrency; the instance needs more connections or the work needs to queue.
- Few rows and still timeouts: the compute is waking from scale-to-zero. Neon suspends the compute after 5 minutes without traffic, and the first connection can take close to a second. If the alert repeats right after idle periods, check `neon-quota.md` before touching the pool.

## Mitigate

1. Fix the long transaction first; it is the only change that removes the cause. Statements are cut at 5 seconds by default (`statement_timeout`), so a transaction older than that points to waiting between statements.
2. If the load is genuine, raise `DB_POOL_MAX` in Vercel (Settings, Environment Variables, Production) and redeploy. Keep `instances x DB_POOL_MAX` below the pooler's server-side limit: PgBouncer in transaction mode accepts up to 10,000 clients but gives each user and database pair a pool of 0.9 x `max_connections`, which depends on the compute size (https://neon.com/docs/connect/connection-pooling).
3. If the compute is too small for the load, the limit is the plan. Free allows up to 2 CU; moving the project to Launch is a console change described in `neon-quota.md`, and it is the spending rule's trigger only after the checks above rule out code.

## Verify

No new `ops.alert` with `kind: db-pool-exhausted` in the production logs for 30 minutes of normal traffic, and the query above shows no transaction older than 5 seconds.

## Record

Date, instance count and `DB_POOL_MAX` before and after, the query or code path that held the connections, and what changed.
