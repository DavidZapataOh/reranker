# Neon setup

## Trigger

A Neon project must be created or rebuilt: first setup, a lost project, or a new region. Also use it to rotate the owner password or the API keys.

## Impact

Without the two projects there is no database: the `ci / migrate` check cannot migrate production, previews cannot get their branch, and the `ci` integration job cannot create its branch. Production data lives only in `reranker-prod`; `reranker-nonprod` holds the per-pull-request `preview/pr-<n>` branches and the ephemeral CI branches, all children of its `main`, and never real customer data.

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
3. Copy the direct connection string (no `-pooler`, `sslmode=verify-full`) of `reranker_owner` in `reranker-prod`: it is `DATABASE_URL_MIGRATIONS`. `reranker-nonprod` needs none stored: the preview and CI workflows get each branch's owner URL from the Neon API. The runtime logins `reranker_app` and `reranker_system` are created later by `pnpm --filter @reranker/db db:provision-roles`, which takes their passwords from `DB_LOGIN_PASSWORDS`; their URLs are the pooled host (`ep-*-pooler`).
4. Create the API keys in the console under Account settings:
   - CI: limited to `reranker-nonprod`. GitHub secret `NEON_NONPROD_API_KEY`; the workflows expose it to the jobs as `NEON_API_KEY`.
   - Vercel Production: reads both projects, used by `db:usage`. Vercel Secret `NEON_API_KEY`.
5. Store the URLs. Vercel Production gets `DATABASE_URL` (pooled, `reranker_app`) and `DATABASE_URL_SYSTEM` (pooled, `reranker_system`) as Secrets. `DATABASE_URL_MIGRATIONS` goes only to the GitHub Environment `production`, read from stdin: `gh secret set DATABASE_URL_MIGRATIONS --env production`. Vercel never holds it, and Preview holds no database URL: the `preview` workflow passes each deployment the URLs of its own branch.
6. Move each project to the Launch plan when it reaches 80 % of a Free limit (100 CU-hours or 1 GB). It is a console click; the connection strings do not change.

## Verify

```bash
neonctl projects list --output json | jq '.projects[] | {name, pg_version, region_id}'
neonctl branches list --project-id <project id>
```

Both projects report `pg_version: 18` and `region_id: aws-us-east-1`, and each lists `main`. Then open a pull request: the `preview` workflow creates `preview/pr-<n>`, migrates it and deploys. After the merge, `ci / migrate` migrates `reranker-prod`.

## Record

Required when a project is created or rebuilt: the project ids, the date, and where each secret was stored. Never write connection strings, passwords or API keys in the record.
