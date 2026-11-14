# Rotate a secret

## Trigger

A secret was exposed (pasted in a log, a screenshot or a public repository), a provider reports a leak, a person with access to it leaves, or its cadence below is due. An exposed secret is rotated the same day; a due one within the week.

## Impact

Until rotated, whoever holds the old value can act as the product against that provider. Rotating without the order below can take the app down: the old value stops working before the new one is deployed.

## Diagnose

Find where the secret lives in the inventory below and whether it is active. The catalog in `packages/env/src/catalog.ts` is the source; `pnpm secrets:audit` lists the GitHub names and fails on any that the catalog does not allow.

```bash
pnpm secrets:audit
vercel env ls
```

Names only: neither command prints values.

## Mitigate

1. Create the new value in the provider's console. Keep the old one valid.
2. Set the new value in every store of the inventory row, Production first. In Vercel keep the type Secret, and Production must differ from Preview and Development (team policy Separate Production Secret Values). For GitHub use `gh secret set <NAME>` (or `gh variable set <NAME>` for a variable); never pass the value on the command line, read it from stdin.
3. Redeploy production so the new value is live: `vercel deploy --prod` or promote a fresh build.
4. Revoke the old value in the provider's console once the new deployment serves traffic.
5. Secrets that rotate with versions (`BETTER_AUTH_SECRETS`): add the new version first, deploy, and remove the old one after sessions issued with it expire.

## Verify

```bash
pnpm secrets:audit
curl -s https://reranker.co/api/health
```

The audit reports `unexpected: []` and `missing: []`, the health check answers `200`, and the provider's console shows the old value revoked and the new one in use.

## Record

Required. Update the "Last rotation" cell of the row in this file in the same pull request, with the date. If the cause was an exposure, add the incident cause and how it was found to the pull request description.

## Inventory

`Where it lives`: Prod, Prev and Dev are Vercel environments; GH is a GitHub repository secret (a CI value, never a production credential). Rows marked "not active yet" belong to a plan that has not shipped; they are rotated from the day they exist.

| Secret | Where it lives | Last rotation | Cadence |
|---|---|---|---|
| `POSTHOG_FEATURE_FLAGS_KEY` | Prod, Prev, Dev | not active yet | 180 days |
| `POSTHOG_API_KEY` | Prod | not active yet | 180 days |
| `POSTHOG_READONLY_API_KEY` | GH | not active yet | 180 days |
| `POSTHOG_PERSONAL_API_KEY` | GH | not active yet | 180 days |
| `POSTHOG_QUERY_READ_KEY` | Prod | not active yet | 180 days |
| `BETTERSTACK_HEARTBEAT_DAILY_URL` | Prod | not active yet | 180 days |
| `BETTERSTACK_HEARTBEAT_NIGHTLY_URL` | GH | not active yet | 180 days |
| `GITHUB_BILLING_READ_TOKEN` | Prod | not active yet | 180 days |
| `DATABASE_URL` | Prod, Prev, Dev | not rotated yet | 180 days |
| `DATABASE_URL_SYSTEM` | Prod, Prev, Dev | not rotated yet | 180 days |
| `DATABASE_URL_MIGRATIONS` | Prod, Prev, Dev | not rotated yet | 180 days |
| `DB_LOGIN_PASSWORDS` | GH | not active yet | 180 days |
| `NEON_API_KEY` | Prod | not active yet | 180 days |
| `BETTER_AUTH_SECRET` | Prod, Prev, Dev | not active yet | 180 days |
| `BETTER_AUTH_SECRETS` | Prod, Prev, Dev | not active yet | 180 days |
| `GOOGLE_CLIENT_SECRET` | Prod, Prev, Dev | not active yet | 180 days |
| `RESEND_API_KEY` | Prod, Prev, Dev | not active yet | 180 days |
| `RESEND_API_KEY_CI` | GH | not active yet | 180 days |
| `RESEND_WEBHOOK_SECRET` | Prod, Prev, Dev | not active yet | 180 days |
| `LEAD_LINK_SECRET` | Prod, Prev, Dev | not active yet | 180 days |
| `LEAD_SUBJECT_SECRET` | Prod, Prev, Dev | not active yet | 180 days |
| `TURNSTILE_SECRET_KEY` | Prod, Prev, Dev | not active yet | 180 days |
| `CAPACITY_HMAC_KEY` | Prod, Prev, Dev | not active yet | 180 days |
| `FREE_REPORT_CHOICE_KEY` | Prod, Prev, Dev | not active yet | 180 days |
| `QUALITY_CANARY_TOKEN` | Prod, Prev, Dev, GH | not active yet | 180 days |
| `CRON_SECRET` | Prod, Prev | not active yet | 180 days |
| `DATAFORSEO_LOGIN` | Prod, Prev, Dev, GH | not active yet | 180 days |
| `DATAFORSEO_PASSWORD` | Prod, Prev, Dev, GH | not active yet | 180 days |
| `OPENAI_API_KEY` | Prod, Prev, Dev | not active yet | 180 days |
| `OPENAI_API_KEY_CI` | GH | not active yet | 180 days |
| `GEMINI_API_KEY` | Prod, Prev, Dev | not active yet | 180 days |
| `BRIGHTDATA_API_KEY` | Prod | not active yet | 180 days |
| `BRIGHTDATA_API_KEY_CI` | GH | not active yet | 180 days |
| `ANTHROPIC_API_KEY_CI` | GH | not active yet | 180 days |
| `XAI_API_KEY_CI` | GH | not active yet | 180 days |
| `GOOGLE_PLACES_API_KEY` | Prod, Prev, Dev | not active yet | 180 days |
| `GOOGLE_PLACES_API_KEY_CI` | GH | not active yet | 180 days |
| `R2_ACCESS_KEY_ID` | Prod, Prev, Dev | not active yet | 180 days |
| `R2_SECRET_ACCESS_KEY` | Prod, Prev, Dev | not active yet | 180 days |
| `CLOUDFLARE_CACHE_PURGE_TOKEN` | Prod, Prev, Dev | not active yet | 180 days |
| `EVIDENCE_CAPTURE_SIGNING_KEY` | Prod, Prev, Dev | not active yet | 180 days |
| `EVIDENCE_LOG_SIGNING_KEY` | Prod, Prev, Dev | not active yet | 180 days |
| `TURBO_REMOTE_CACHE_SIGNATURE_KEY` | Prod, Prev, Dev, GH | not rotated yet | 180 days |
| `VERCEL_AUTOMATION_BYPASS_SECRET` | GH | not rotated yet | 180 days |
| `NEON_NONPROD_API_KEY` | GH | not rotated yet | 180 days |
