# Neon setup

Procedure, not an alert: how the two Neon projects, their roles and connection strings are created, and how production moves to the Launch plan.

## Trigger

- A new environment is being created, or a project has to be rebuilt from scratch.
- `reranker-prod` reaches 80% of its monthly compute hours or 800 MB of storage, or the first sale happens (see "Move production to Launch").

## Impact

Without these steps the app has no database: `@reranker/db` refuses to start when `DATABASE_URL` or `DATABASE_URL_SYSTEM` is missing, and the Vercel build stops before `next build` when `db:migrate` cannot reach `DATABASE_URL_MIGRATIONS`.

## Layout

| Project | Root branch | Owner role | Compute | Use |
|---|---|---|---|---|
| `reranker-prod` | `main` | `reranker_owner` | autoscaling 0.25–1 CU, scale to zero after 5 min | Production |
| `reranker-nonprod` | `main`, with the child `preview` | `neondb_owner` | autoscaling 0.25–0.5 CU, scale to zero after 5 min | `main` stays unmigrated: it is the parent every CI run forks from. `preview` serves Vercel Preview and local development |

`main` in `reranker-nonprod` is never migrated by hand, by a preview or locally. A preview builds an unmerged branch and runs `db:migrate`; if that ran on `main`, every later CI branch would inherit migrations that `main` of the repository may never get, and CI would stop testing the schema production will have. CI migrates each ephemeral branch itself. With up to 8 CI branches alive, `main` and `preview` stay within the 10-branch cap.

Both live in `aws-us-east-1` on Postgres 18 (`uuidv7()` is native from 18; Neon never upgrades a major version in place) with the database `neondb`. Each Free project has its own 100 CU-hours, 1 GB and 10 branches per month, so CI never spends production compute. The CI owner stays `neondb_owner` because `.github/actions/neon-ci-branch` connects with that role.

Nothing may keep a compute awake without traffic: no health check, polling or `LISTEN` touches the database. On Free the scale-to-zero delay is fixed at 5 minutes.

Roles:

| Role | Kind | Created by | Purpose |
|---|---|---|---|
| owner (`reranker_owner` / `neondb_owner`) | login, `neon_superuser` | Neon at project creation | Migrations and `db:provision-roles` only, over the direct host |
| `app_tenant`, `app_system` | group, `NOLOGIN` | migration `0001_core` | Hold every grant and policy |
| `reranker_app` | login in `app_tenant` | `db:provision-roles` | Runtime tenant traffic, subject to RLS |
| `reranker_system` | login in `app_system` | `db:provision-roles` | Runtime system traffic (auth, jobs) |

Logins created with SQL do not join `neon_superuser`, so they never get `BYPASSRLS`.

## Steps

### 1. Create the projects

The console's New Project dialog cannot name the owner role, so production is created through the API with an org-scoped key (Console → Organization settings → API keys). `NEON_ORG_ID` is in Organization settings.

```bash
curl -sS https://console.neon.tech/api/v2/projects \
  -H "Authorization: Bearer $NEON_API_KEY" -H "Content-Type: application/json" \
  -d '{
    "project": {
      "name": "reranker-prod",
      "org_id": "'"$NEON_ORG_ID"'",
      "region_id": "aws-us-east-1",
      "pg_version": 18,
      "branch": { "name": "main", "database_name": "neondb", "role_name": "reranker_owner" },
      "default_endpoint_settings": { "autoscaling_limit_min_cu": 0.25, "autoscaling_limit_max_cu": 1 }
    }
  }' | jq '{id: .project.id, pg: .project.pg_version, region: .project.region_id}'
```

Repeat for `reranker-nonprod` with `"autoscaling_limit_max_cu": 0.5` and without `role_name` (Neon names it `neondb_owner`). The response carries the owner password once; it goes straight into the encrypted variables of step 3 and nowhere else.

Then create the `preview` branch of `reranker-nonprod` from `main`, with its own read-write compute:

```bash
curl -sS https://console.neon.tech/api/v2/projects/$NONPROD_PROJECT_ID/branches \
  -H "Authorization: Bearer $NEON_API_KEY" -H "Content-Type: application/json" \
  -d '{ "branch": { "name": "preview" }, "endpoints": [{ "type": "read_write" }] }' \
  | jq '{branch: .branch.name, parent: .branch.parent_id, host: .endpoints[0].host}'
```

Previews can leave `preview` in a state no open pull request needs: a migration edited after a preview ran it, or one merged with an older timestamp, makes `db:migrate` fail naming that migration, while one from an abandoned pull request leaves its schema behind silently. In either case reset it from its parent in the console (Branches → `preview` → Reset from parent) and run step 4 on it again.

### 2. Keys

- GitHub: an API key scoped to `reranker-nonprod` only, stored as the secret `NEON_NONPROD_API_KEY`; its project id is the repository variable `NEON_PROJECT_ID`.
- Vercel Production: `NEON_API_KEY` (reads both projects for usage reports), `NEON_PROJECT_ID` (`reranker-prod`) and `NEON_NONPROD_PROJECT_ID`.

### 3. Connection strings

From Console → project → Connect, with "Connection pooling" off for the direct string and on for the pooled one (`-pooler` in the host). Always keep `sslmode=require` or stricter.

| Variable | Host | Role | Where |
|---|---|---|---|
| `DATABASE_URL_MIGRATIONS` | direct | owner | Vercel, Sensitive: Production (`reranker-prod` `main`) and Preview (`reranker-nonprod` `preview`) |
| `DATABASE_URL` | pooled | `reranker_app` | Vercel Production and Preview, same branches; also local `.env` (`preview`) |
| `DATABASE_URL_SYSTEM` | pooled | `reranker_system` | Vercel Production and Preview, same branches; also local `.env` (`preview`) |
| `DB_POOL_MAX` | – | – | Optional, only to tune pool size per instance (1–20) |

The Vercel build runs `db:migrate` for every Preview and Production deployment once `packages/db` exists, so `DATABASE_URL_MIGRATIONS` must be set in both before the first deployment that includes the package; without it the build stops before `next build`.

### 4. Schema and logins

Run on `reranker-prod` `main` and on `reranker-nonprod` `preview` (never on nonprod `main`), from a trusted machine, with the owner's direct string of that branch:

```bash
export DATABASE_URL_MIGRATIONS='postgresql://<owner>:<password>@<direct-host>/neondb?sslmode=verify-full'
pnpm --filter @reranker/db db:migrate
DB_LOGIN_PASSWORDS="$(jq -cn --arg app "$(openssl rand -hex 24)" --arg system "$(openssl rand -hex 24)" \
  '{reranker_app: $app, reranker_system: $system}')" pnpm --filter @reranker/db db:provision-roles
```

Passwords need at least 60 bits of entropy (Neon's rule for SQL roles); 48 hex characters carry 192. Put them only in the `DATABASE_URL` and `DATABASE_URL_SYSTEM` values of step 3. `db:provision-roles` is idempotent: running it again sets both passwords to what it receives and grants each login its group and the 15 s statement timeout again. It never removes other memberships, so after any manual `grant` check `select r.rolname, g.rolname from pg_auth_members m join pg_roles r on r.oid = m.member join pg_roles g on g.oid = m.roleid where r.rolname like 'reranker\_%'` shows only `reranker_app → app_tenant` and `reranker_system → app_system`. Neon keeps roles per branch and copies them only when a child branch is created, so logins provisioned on `preview` never reach nonprod `main`; each CI branch gets its own from `.github/actions/ci-database`, which also migrates it.

### Move production to Launch

Console → Billing → change plan to Launch for the organization that owns `reranker-prod`. Same project, same connection strings, no data migration. Launch has no monthly minimum and bills per CU-hour and GB-month.

## Verify

```bash
curl -sS https://console.neon.tech/api/v2/projects/$PROJECT_ID -H "Authorization: Bearer $NEON_API_KEY" \
  | jq '.project | {name, pg_version, region_id}'
curl -sS https://console.neon.tech/api/v2/projects/$PROJECT_ID/branches -H "Authorization: Bearer $NEON_API_KEY" \
  | jq '[.branches[] | select(.default) | .name]'
psql "$DATABASE_URL" -c "select current_user, current_setting('statement_timeout')"
```

Expected: `pg_version: 18`, `region_id: aws-us-east-1`, default branch `main`, and through the pooled string `reranker_app | 15s`.

## Record

Date, project ids, who ran the steps, the `db:migrate` JSON line, and which Vercel variables were set (names only, never values).
