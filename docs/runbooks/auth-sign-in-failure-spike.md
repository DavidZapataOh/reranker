# Sign-in failure spike

## Trigger

The `auth-sign-in-failure-spike` alert (critical, source `auth`), raised by the `auth-telemetry` Better Auth plugin when, over the last 10 minutes, at least 20 sign-in attempts were made and more than 30% of them failed. It fires once, on the attempt that crosses the threshold, and the inbox gets at most one email per hour. The payload carries `attempts_10m` and `failed_10m`.

An attempt is a finished request on one of the three sign-in routes: `/sign-in/email-otp` (code), `/callback/google` (Google redirect) and `/one-tap/callback` (Google One Tap). A failure is a wrong, expired or exhausted code (`invalid_otp`, `otp_expired`, `too_many_attempts`) or a Google sign-in that ended in an error (`oauth_error`). Requests the rate limiter refused never reach the plugin and are not counted here.

## Impact

Either someone is guessing codes against real addresses, or sign-in is broken for real people. Each code allows 5 attempts and `/sign-in/email-otp` allows 5 requests per minute per IP, so guessing is slow, but legitimate users locked out by a broken flow cannot use their account at all. Free reports and everything outside `/api/auth` keep working.

## Diagnose

In PostHog, Product analytics, new Trends insight, last 24 hours, by 5-minute interval:

- Event `auth_sign_in_failed`, breakdown by `reason`, next to event `auth_sign_in`, breakdown by `method`.
- Mostly `invalid_otp` with no drop in `auth_sign_in`: code guessing. Event `auth_rate_limited`, breakdown by `route`, usually rises with it.
- Mostly `otp_expired`: codes arrive late. Check the [Sign-in code delivery](auth-email-delivery.md) runbook and Resend's log of recent sends.
- Mostly `oauth_error` and `auth_sign_in` with `method: google` or `one_tap` dropped to zero: Google sign-in is broken. Look at the error logs in PostHog Logs for `/api/auth/callback/google` and at recent deployments in Vercel, Deployments.
- Every reason at once, starting with a deployment: our change broke sign-in.

From the Neon console SQL editor of `reranker-prod`, the per-minute counts behind the alert:

```sql
select bucket_start, count, flagged
from ops.velocity_buckets
where key = 'auth.sign_in' and bucket_start > now() - interval '1 hour'
order by bucket_start desc;
```

And which addresses are being guessed (codes with spent attempts; the value ends in `:<attempts>`):

```sql
select identifier, split_part(value, ':', -1)::int as attempts, expires_at
from auth.verifications
where identifier like 'sign-in-otp-%' and split_part(value, ':', -1)::int >= 3
order by expires_at desc
limit 50;
```

Read the addresses only to judge the pattern (many addresses from one domain, or one address over and over); never copy them anywhere.

## Mitigate

1. Broken flow after a deployment: roll back in Vercel, Deployments, the previous production deployment, Instant Rollback. Then fix forward in a pull request.
2. Google sign-in broken: check in Google Cloud console, Google Auth Platform, Clients, the "Reranker web" OAuth client, that `https://reranker.co/api/auth/callback/google` is still an authorized redirect URI and `https://reranker.co` an authorized JavaScript origin. If `GOOGLE_CLIENT_SECRET` was rotated, follow [Rotate the auth secrets](auth-rotate-secrets.md).
3. Code guessing: the per-code and per-IP limits already contain it, so no setting has to change while `auth_sign_in` keeps its usual level. If it goes on for more than an hour from many networks, lower the `/sign-in/email-otp` rule in `packages/auth/src/rate-limits.ts` (for example to 3 per 60 s) in a pull request and ship it.

## Verify

Within 10 minutes of the fix, the share of `auth_sign_in_failed` over all sign-in events in PostHog falls back under 30%, and `ops.velocity_buckets` for `auth.sign_in` shows `flagged` well below `count` in the latest minutes.

## Record

In the alert thread or the pull request: the cause (guessing, our change, Google, late codes), the time from alert to action, and any limit changed. For alerts, the alert-to-action time target is 15 minutes between 07:00 and 22:00 (Bogota).
