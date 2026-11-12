# Neon setup

Procedure, not an alert. Use it to create the databases from scratch, to provision a root branch, or to move production off the Free plan.

## Layout

| Project | Root branch | Compute | Used by |
|---|---|---|---|
| `reranker-prod` | `main` | autoscaling 0.25–1 CU, scale to zero after 5 min | Production deployments |
| `reranker-nonprod` | `main` | autoscaling 0.25–0.5 CU, scale to zero after 5 min | Local development, preview deployments, CI (one expiring child branch per run) |

Both projects: region `aws-us-east-1`, Postgres 18, database `neondb`, Free plan (100 CU-hours and 1 GB per project per month, 10 branches per project). Two projects keep CI branches from spending production's compute hours.

Roles:

| Role | Created by | Connects through | Used for |
|---|---|---|---|
| `neondb_owner` | Neon, with the project | direct host | `db:migrate` and `db:provision-roles` only; owns every table |
| `app_tenant`, `app_system` | the core migration | (no login) | groups that hold every grant and RLS policy |
| `reranker_app` ∈ `app_tenant` | `db:provision-roles` | `-pooler` host | `withTenant` / `withTenants`, subject to RLS |
| `reranker_system` ∈ `app_system` | `db:provision-roles` | `-pooler` host | `withSystem` and the auth adapter |

Never create the runtime logins in the console: roles created there join `neon_superuser`, which bypasses RLS. Roles created through SQL do not.

## Create a project

1. Neon console → New project: name `reranker-prod` (or `reranker-nonprod`), Postgres 18, region AWS US East 1 (N. Virginia).
2. Branches → `main` → Computes → Edit: set the autoscaling range from the table above. Scale to zero stays at 5 minutes (fixed on Free).
3. Note the project id (Settings → General).
4. For `reranker-nonprod` only: Settings → API keys → create a project-scoped key. It becomes the GitHub secret `NEON_NONPROD_API_KEY`; the project id becomes the GitHub variable `NEON_PROJECT_ID`.

## Provision a root branch

Run from the repository root with the owner's **direct** connection string (Dashboard → Connect → role `neondb_owner`, connection pooling off). Read secrets without echoing them so they never reach the shell history:

```bash
read -rs DATABASE_URL_MIGRATIONS && export DATABASE_URL_MIGRATIONS
app=$(openssl rand -hex 24); system=$(openssl rand -hex 24)
export DB_LOGIN_PASSWORDS=$(jq -cn --arg app "$app" --arg system "$system" '{reranker_app: $app, reranker_system: $system}')
pnpm --filter @reranker/db db:migrate
pnpm --filter @reranker/db db:provision-roles
```

`db:migrate` prints `{"applied":N,"concurrent":[],"ms":…}`; `db:provision-roles` prints which logins it created or updated. Both are idempotent; rerunning `db:provision-roles` rotates the passwords to the ones given.

Then store the runtime connection strings, built on the **pooled** host (`ep-…-pooler.us-east-1.aws.neon.tech`), as encrypted Vercel environment variables:

| Variable | Production (`reranker-prod`) | Preview (`reranker-nonprod`) |
|---|---|---|
| `DATABASE_URL` | `postgresql://reranker_app:$app@<pooled host>/neondb?sslmode=verify-full` | same, nonprod host and password |
| `DATABASE_URL_SYSTEM` | `postgresql://reranker_system:$system@<pooled host>/neondb?sslmode=verify-full` | same, nonprod host and password |
| `DATABASE_URL_MIGRATIONS` | owner direct URL (Sensitive) | owner direct URL of nonprod (Sensitive) |
| `DB_POOL_MAX` | optional, 1–20 | optional |

The Vercel build runs `db:migrate` before `next build` whenever `APP_ENV` is `preview` or `production`.

`unset app system DB_LOGIN_PASSWORDS DATABASE_URL_MIGRATIONS` when done.

## Move production to Launch

Do it at the first of: compute hours above 80 % of the month, storage above 800 MB, or the first paid customer (7-day restore window instead of 6 hours). On Free, running out of compute suspends the database until next month and a full disk rejects writes.

Neon console → Billing → Change plan → Launch. Connection strings, roles and data stay the same; nothing redeploys.

## Verify

```bash
neonctl projects list
neonctl branches list --project-id <id>
```

- Both projects show `pg_version: 18` and `region_id: aws-us-east-1`, each with a `main` branch.
- `psql "$DATABASE_URL" -c "select current_user, current_setting('statement_timeout')"` returns `reranker_app | 15s`.
- `psql "$DATABASE_URL_MIGRATIONS" -c "select rolname, rolbypassrls from pg_roles where rolname like 'reranker_%'"` shows `rolbypassrls = f` for both logins.

## Record

Date, project, what was created or changed, the `db:migrate` and `db:provision-roles` output (never the passwords), and where each variable was stored.
