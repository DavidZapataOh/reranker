# Rotate the auth secrets

## Trigger

One of the sign-in secrets was exposed, a provider reports a leak, or its cadence in [Rotate a secret](rotate-secret.md) is due: `BETTER_AUTH_SECRET` and `BETTER_AUTH_SECRETS`, `GOOGLE_CLIENT_SECRET`, `RESEND_API_KEY` (and its CI copy `RESEND_API_KEY_CI`), `TURNSTILE_SECRET_KEY` and `CAPACITY_HMAC_KEY`. An exposed secret is rotated the same day. This runbook is the auth-specific order; the general rules (Secret type in Vercel, Production different from Preview and Development, values read from stdin, never on the command line) are in [Rotate a secret](rotate-secret.md).

## Impact

Done in this order, sign-in keeps working through the rotation. The one visible effect is the Better Auth secret: every browser has to sign in again (see below). Rotating in the wrong order breaks sign-in for everyone until the next deployment.

## Diagnose

Decide which secrets to rotate and in which environments; each environment has its own value:

```bash
vercel env ls production
vercel env ls preview
gh secret list
```

Google has two OAuth clients ("Reranker web" for production, the development one for previews and local) and Turnstile two widgets, one per environment group, so a leak of one value never needs the other rotated.

## Mitigate

Each secret below ends with a production redeploy (`vercel deploy --prod`, or promote a fresh build) unless it says otherwise.

### Better Auth secret

Better Auth encrypts with the first version listed in `BETTER_AUTH_SECRETS` and decrypts with every listed version and with `BETTER_AUTH_SECRET`, so pending codes, stored Google tokens and sign-ins in progress keep working across the change. The session cookie, though, is signed with the current version only (Better Auth 1.7): after the deployment every browser is signed out and signs in again. Sessions stay valid in the database; nothing else is lost. Rotate outside peak hours unless the secret was exposed.

1. Generate the value: `openssl rand -base64 32`.
2. First rotation (no `BETTER_AUTH_SECRETS` yet): set `BETTER_AUTH_SECRETS` to `1:<new>` and leave `BETTER_AUTH_SECRET` as it is; it is the previous value. Later rotations: put the new version first, `2:<new>,1:<previous>`, raising the number each time.
3. Set it in Production with `vercel env add BETTER_AUTH_SECRETS production` (the value from stdin), redeploy production, then repeat for Preview with a different value.
4. Sign in on https://reranker.co and confirm the session works.
5. A day later, when no code or sign-in in progress can still need it, drop the previous version: `BETTER_AUTH_SECRETS` keeps only the newest entry, and `BETTER_AUTH_SECRET` is set to that same value so the old one decrypts nothing. Redeploy. This second change does not sign anyone out.

### Google OAuth client secret

1. Google Cloud console, Google Auth Platform, Clients, the OAuth client of the environment, Add Secret. Both secrets work until the old one is disabled; a client holds at most two.
2. Set `GOOGLE_CLIENT_SECRET` in that environment in Vercel and redeploy.
3. Sign in with Google on the environment, then back in the client, disable and delete the old secret.

### Resend API key

1. Resend, API Keys, Create API Key with Sending access restricted to `mail.reranker.co`.
2. Set `RESEND_API_KEY` in the environment in Vercel and redeploy. For the CI copy, `gh secret set RESEND_API_KEY_CI` with a key of the Resend test account; no deployment needed.
3. Request a sign-in code and confirm it arrives, then delete the old key in Resend, API Keys.

### Turnstile secret key

1. Cloudflare dashboard, Turnstile, the widget of the environment, Settings, Rotate Secret Key. Both keys work for the two hours the rotation takes.
2. Set `TURNSTILE_SECRET_KEY` in the environment in Vercel and redeploy within those two hours.
3. Request a sign-in code to confirm the check passes. Production refuses Cloudflare's testing keys at startup by design.

### Capacity HMAC key

Set a new `CAPACITY_HMAC_KEY` (`openssl rand -base64 32`) and redeploy. The send limits per address and per network start empty, so for one day an address can ask for its full allowance again; nothing else changes.

## Verify

```bash
pnpm secrets:audit
curl -s https://reranker.co/api/auth/ok
```

The audit reports nothing unexpected or missing, `/api/auth/ok` answers `{"ok":true}`, a sign-in with Google and one with a code both succeed on production, and PostHog shows `auth_sign_in` events again with no rise in `auth_sign_in_failed`.

## Record

Update the "Last rotation" cell of each rotated secret in [Rotate a secret](rotate-secret.md) in the same pull request, with the date. If the cause was an exposure, add how it was found to the pull request description.
