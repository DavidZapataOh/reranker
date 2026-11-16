# Database row-level security violation

## Trigger

The `db-rls-violation` alert (critical, source `db`). It fires on any occurrence of Postgres error `42501` (`insufficient_privilege`) raised through `withTenant`, `withTenants` or `withSystem`, with no threshold: the policies reject a statement that touched another tenant's rows, wrote a row for a tenant the transaction did not declare, or ran with a role that has no grant.

## Impact

The statement was rejected, so no data crossed a tenant boundary. The caller received a generic `internal` error and the customer sees a failed action. If the cause is a code bug, every request that takes the same path fails the same way, so the failure repeats until the path is fixed or switched off. Other routes keep working.

## Diagnose

The alert carries `pool` (`app` or `system`), `pgCode` and, for `system`, the `reason` the code gave to `withSystem`. Find the request around the alert:

```bash
vercel logs <production deployment url> --since 1h
```

Search the output for `ops.alert` with `kind: db-rls-violation`, then for the request error logged next to it. Read the kind of cause from the pair `pool` and `reason`:

- `pool: app` and no `reason`: a tenant route inserted or updated a row whose `tenant_id` is not one of the tenants the transaction declared, or queried a table the `app_tenant` role has no grant on. This is a code bug.
- `pool: system` with a `reason`: a job or webhook used `withSystem` against a table without the `app_system` policy or grant. This is a code bug, or a migration that did not reach this database.
- A burst of alerts from one client, with varied tenant ids in the request path: someone is probing identifiers. The policies are doing their job; confirm that no request in the same window succeeded against a foreign tenant.

To confirm the policies are intact in the database itself, run this in the Neon console SQL editor of the affected project; it must return no rows:

```sql
select c.relname
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'app' and c.relkind = 'r' and not c.relrowsecurity;
```

A table listed has row-level security switched off, and a migration did not reach this database.

## Mitigate

1. If the cause is a code bug on one route, turn that route off with its PostHog flag (Feature flags, set the flag to 0 %). Flags are defined by the plan that ships each route; until a route has one, use Vercel instant rollback: Deployments, open the previous production deployment, "Instant Rollback".
2. If a migration is missing in the database, trigger a new production deployment: the Vercel build applies pending migrations before it promotes. Do not run `db:migrate` by hand against production.
3. If it is probing, leave the routes on and do nothing else here; rate limiting for public routes belongs to the plan that ships them and is not available yet.
4. Fix the code path with a test that reproduces the rejected statement, and ship it through the normal pull request.

## Verify

After the fix or the flag change, no new `ops.alert` with `kind: db-rls-violation` appears in the production logs for 30 minutes of normal traffic. The email is sent at most once per hour per kind, so a silent inbox alone proves nothing: check the logs.

## Record

Required for every occurrence. Write the date, the `pool` and `reason`, whether it was a bug or probing, the route and the fix or flag used. For the alert-to-action target see the template: 15 minutes between 07:00 and 22:00 (Bogota).
