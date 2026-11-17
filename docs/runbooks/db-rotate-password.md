# Rotate the database login passwords

## Trigger

A login password was exposed, someone with access to it leaves, or its cadence in `rotate-secret.md` is due. It covers the runtime logins `reranker_app` and `reranker_system`; the owner `reranker_owner` is covered in the last paragraph of Mitigate. Do it per project: `reranker-prod` first only if the exposure involved it, otherwise `reranker-nonprod`, then `reranker-prod`.

## Impact

Rotation changes the password inside Postgres, so the old `DATABASE_URL` and `DATABASE_URL_SYSTEM` stop authenticating for new connections as soon as `db:provision-roles` runs. Instances still running the old values fail to open new connections until the redeploy completes, and queries return `service_unavailable`. Connections that are already open keep working. The reconnection window is short and accepted at this stage; run it at the lowest-traffic hour.

## Diagnose

Confirm the project and that both logins exist, in the Neon console SQL editor of that project. The result must list both names; a missing one is created by step 3, not an error.

```sql
select rolname from pg_roles where rolname in ('reranker_app', 'reranker_system');
```

## Mitigate

1. Generate a new password for each login with at least 60 bits of entropy; Neon rejects weaker ones. A 16-character random alphanumeric string is enough:

```bash
openssl rand -base64 24 | tr -d '/+=' | cut -c1-24
```

2. Export both in the local shell only, never in a file or a command line that is recorded:

```bash
export DB_LOGIN_PASSWORDS='{"reranker_app":"<new>","reranker_system":"<new>"}'
export DATABASE_URL_MIGRATIONS=<direct owner URL of the project>
```

3. Apply them: `pnpm --filter @reranker/db db:provision-roles`. It updates the existing roles and prints which ones it created or updated.
4. Build the new pooled URLs (host `ep-*-pooler`, same database, the new password) and set them in Vercel for the matching environment: `DATABASE_URL` for `reranker_app` and `DATABASE_URL_SYSTEM` for `reranker_system`, type Secret (Settings, Environment Variables). Only Production holds them: each preview gets fresh logins on its own branch when it deploys.
5. Redeploy: `vercel deploy --prod`, or redeploy the latest production deployment from the dashboard.
6. Clear the shell: `unset DB_LOGIN_PASSWORDS DATABASE_URL_MIGRATIONS`.

For the owner `reranker_owner`: reset its password in the Neon console (project, Roles and databases, the role menu, Reset password; https://neon.com/docs/manage/roles), then update the production value from stdin with `gh secret set DATABASE_URL_MIGRATIONS --env production`. The next `ci / migrate` run uses it, so nothing needs a redeploy. Nothing is stored for `reranker-nonprod`: the workflows get each branch's owner URL from the Neon API.

## Verify

```bash
curl -s https://reranker.co/api/health
pnpm --filter @reranker/db db:provision-roles
```

The health check answers `200`, the second run reports the roles as updated again without error, and a real request that reads data succeeds. Failed connections stop within one deployment's time; if they continue, an instance still has the old value.

## Record

Update the "Last rotation" cells of `DATABASE_URL`, `DATABASE_URL_SYSTEM`, `DATABASE_URL_MIGRATIONS` and `DB_LOGIN_PASSWORDS` in `rotate-secret.md` in the same pull request, with the date. Never write a password or a connection string anywhere.
