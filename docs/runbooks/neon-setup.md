# Neon setup

A procedure, not an alert: how the two Neon projects are created and wired, and how to bring a root branch to a working state. Follow it once per project and again whenever a root branch is recreated or restored.

## Layout

| Project | Root branch | Compute | Used by |
|---|---|---|---|
| `reranker-prod` | `main` | autoscaling 0.25–1 CU, scale to zero after 5 min | Vercel Production |
| `reranker-nonprod` | `main` | autoscaling 0.25–0.5 CU, scale to zero after 5 min | Local development, Vercel Preview, CI child branches |

Both projects run on the Free plan in `aws-us-east-1` with Postgres 18. Free gives each project 100 CU-hours a month, 1 GB of storage and 10 branches; two projects keep CI and previews from spending production's compute. CI creates one expiring child branch of `reranker-nonprod/main` per run (`.github/actions/neon-ci-branch`) and never keeps more than 8 alive.

Nothing may keep a compute awake without traffic: no health check, polling job or `LISTEN` touches the database.

## Roles and connection strings

| Role | Kind | Created by | Connects through | Variable |
|---|---|---|---|---|
| `neondb_owner` | owner (member of `neon_superuser`) | Neon, with the project | direct host | `DATABASE_URL_MIGRATIONS` |
| `app_tenant` | group, `NOLOGIN` | migration `0001_core` | — | — |
| `app_system` | group, `NOLOGIN` | migration `0001_core` | — | — |
| `reranker_app` | login in `app_tenant` | `db:provision-roles` | `-pooler` host | `DATABASE_URL` |
| `reranker_system` | login in `app_system` | `db:provision-roles` | `-pooler` host | `DATABASE_URL_SYSTEM` |

- The owner runs migrations and owns every object. It never serves traffic.
- The two logins are created with SQL, so Neon does not add them to `neon_superuser`: they have no `BYPASSRLS` and row level security applies to them.
- Runtime traffic always uses the pooled host (`ep-…-pooler…`), which runs PgBouncer in transaction mode. Session `SET`, `LISTEN/NOTIFY` and session advisory locks do not work there; tenancy uses `set_config(…, true)` inside each transaction and job claims use `for update skip locked` or `pg_try_advisory_xact_lock`.
- Migrations and provisioning use the direct host: the migration runner holds a session advisory lock.

## Create a project

1. In the Neon console, create the project with the name from the table, region **AWS US East 1 (N. Virginia)**, Postgres **18**.
2. In **Branches → main → Computes → Edit**, set the autoscaling range from the table and keep scale to zero at 5 minutes.
3. In **Dashboard → Connect**, copy the direct connection string of `neondb_owner` for database `neondb`. Keep `sslmode=verify-full`.
4. Note the pooled host: the same host with `-pooler` appended to the endpoint id.

## Bring a root branch up

Run from the repository root with the direct owner URL of the branch.

```bash
export DATABASE_URL_MIGRATIONS='postgresql://neondb_owner:…@ep-….us-east-1.aws.neon.tech/neondb?sslmode=verify-full'
pnpm --filter @reranker/db db:migrate
```

Expected: one JSON line such as `{"applied":2,"concurrent":[],"ms":…}`. A second run prints `"applied":0`.

Create or rotate the runtime logins with fresh passwords (at least 60 bits of entropy; `openssl rand -hex 24` gives 192):

```bash
app=$(openssl rand -hex 24); system=$(openssl rand -hex 24)
DB_LOGIN_PASSWORDS=$(jq -cn --arg app "$app" --arg system "$system" '{reranker_app: $app, reranker_system: $system}') \
  pnpm --filter @reranker/db db:provision-roles
```

Expected: `{"created":["reranker_app","reranker_system"],"updated":[]}` the first time and both names under `updated` afterwards. The script never prints the passwords. Child branches copy roles from their parent, so CI provisions its own fresh passwords on every run.

Build the runtime URLs with the pooled host and store them only as encrypted environment variables:

```
DATABASE_URL=postgresql://reranker_app:<app>@ep-…-pooler.us-east-1.aws.neon.tech/neondb?sslmode=verify-full
DATABASE_URL_SYSTEM=postgresql://reranker_system:<system>@ep-…-pooler.us-east-1.aws.neon.tech/neondb?sslmode=verify-full
```

| Where | Variables | Points to |
|---|---|---|
| Vercel Production | `DATABASE_URL`, `DATABASE_URL_SYSTEM`, `DATABASE_URL_MIGRATIONS` (Sensitive) | `reranker-prod/main` |
| Vercel Preview | the same three | `reranker-nonprod/main` |
| GitHub Actions | secret `NEON_NONPROD_API_KEY` (key limited to `reranker-nonprod`), variable `NEON_PROJECT_ID` | `reranker-nonprod` |

With `APP_ENV` set to `preview` or `production`, the Vercel build runs `db:migrate` before `next build` and refuses to build when `APP_ENV` is missing. Never put `DB_LOGIN_PASSWORDS` in Vercel or GitHub: it lives only in the shell that runs the provisioning.

## Verify

```bash
neonctl projects list                          # both projects, pg_version 18, region aws-us-east-1
neonctl branches list --project-id <id>        # main in each project
```

Connected as the owner:

```sql
select rolname, rolbypassrls, rolsuper from pg_roles where rolname like 'reranker\_%';      -- both false
select r.rolname, g.rolname from pg_auth_members m
  join pg_roles r on r.oid = m.member join pg_roles g on g.oid = m.roleid
 where r.rolname in ('reranker_app', 'reranker_system');                                   -- app_tenant, app_system
```

Connected as `reranker_app` through the pooled host, `show statement_timeout` returns `15s` and `select has_schema_privilege('auth', 'USAGE'), has_schema_privilege('ops', 'USAGE')` returns `false, false`.

## Move to Launch

Upgrade `reranker-prod` to Launch in **Billing** when its month reaches 80 % of the CU-hours or storage, or at the first sale, whichever comes first. On Free an exhausted compute suspends the database until the next month and a full disk rejects writes. The upgrade keeps the same endpoints and URLs; no data moves and nothing needs a redeploy.
