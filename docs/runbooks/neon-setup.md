# Neon setup

## Trigger

A Neon project must be created or rebuilt: first setup, a lost project, or a new region. Also use it to rotate the owner password or the API keys.

## Impact

Without the two projects there is no database: production and preview builds cannot migrate, and the `ci` integration job cannot create its branch. Production data lives only in `reranker-prod`; `reranker-nonprod` holds previews and ephemeral CI branches and never real customer data.

## Diagnose

```bash
neonctl projects list
neonctl branches list --project-id <project id>
```

Expected: `reranker-prod` and `reranker-nonprod`, both with `pg_version: 18` and `region_id: aws-us-east-1`, each with a `main` branch. A different version or region cannot be changed in place; the project must be recreated.

## Mitigate

1. Create the projects in the Neon console, Postgres 18, `aws-us-east-1`, default branch `main`:
   - `reranker-prod`: autoscaling 0.25 to 1 CU, scale to zero after 5 minutes.
   - `reranker-nonprod`: autoscaling 0.25 to 0.5 CU.
2. Create the owner role in each project with `neonctl roles create --name reranker_owner --project-id <project id>`. Neon's API cannot rename roles, so the console-created `neondb_owner` stays untouched and is not used by the application; migrations run as `reranker_owner`. Store its password only in the secret stores below.
3. Copy both connection strings of `reranker_owner` for each project: the direct one (no `-pooler`) is `DATABASE_URL_MIGRATIONS`. The runtime logins `reranker_app` and `reranker_system` are created later by `pnpm --filter @reranker/db db:provision-roles`, which takes their passwords from `DB_LOGIN_PASSWORDS`; their URLs are the pooled host (`ep-*-pooler`).
4. Create the API keys in the console under Account settings:
   - CI: limited to `reranker-nonprod`. GitHub secret `NEON_NONPROD_API_KEY`; the workflows expose it to the jobs as `NEON_API_KEY`.
   - Vercel Production: reads both projects, used by `db:usage`. Vercel Secret `NEON_API_KEY`.
5. Set the Vercel variables. Production gets the `reranker-prod` URLs and Preview gets the `reranker-nonprod` ones: `DATABASE_URL` (pooled, `reranker_app`), `DATABASE_URL_SYSTEM` (pooled, `reranker_system`) and `DATABASE_URL_MIGRATIONS` (direct, `reranker_owner`) as a Secret.
6. Move each project to the Launch plan when it reaches 80 % of a Free limit (100 CU-hours or 1 GB). It is a console click; the connection strings do not change.

## Verify

```bash
neonctl projects list --output json | jq '.projects[] | {name, pg_version, region_id}'
neonctl branches list --project-id <project id>
```

Both projects report `pg_version: 18` and `region_id: aws-us-east-1`, and each lists `main`. Then run `pnpm --filter @reranker/db db:migrate` with `DATABASE_URL_MIGRATIONS` pointing at `reranker-nonprod`: it applies cleanly.

## Record

Required when a project is created or rebuilt: the project ids, the date, and where each secret was stored. Never write connection strings, passwords or API keys in the record.
