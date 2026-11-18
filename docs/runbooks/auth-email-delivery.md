# Sign-in code delivery

## Trigger

The `auth-email-delivery` alert (critical, source `auth`), raised by `sendAuthEmail` when, over the last 10 minutes, at least 10 sign-in code emails were sent and Resend refused more than 5% of them. It fires once, on the send that crosses the threshold, and the inbox gets at most one email per hour. The payload carries `attempts_10m` (sends) and `failed_10m` (refused). Each refusal also emits an `auth_email_failed` event.

The Resend daily quota warning is not this alert: it comes from the `free-tier-quota` alert of the daily digest ([Free tier quota](free-tier-quota.md)).

## Impact

People asking for a sign-in code do not get it, so nobody without a session can get in with a code. Google and One Tap sign-in, existing sessions and free reports keep working.

## Diagnose

1. Resend dashboard, Emails, filter by sender `codigos@mail.reranker.co`, last hour. The status and the error of the refused sends tell the cause apart:
   - `rate_limit_exceeded` or `daily_quota_exceeded`: the account's sending limits. Compare with Billing, Usage.
   - `invalid_api_key` or `restricted_api_key`: `RESEND_API_KEY` in Vercel Production was revoked, rotated or lacks sending access to `mail.reranker.co`.
   - `validation_error` mentioning the domain: `mail.reranker.co` is no longer verified. Check Domains; a DNS change at Cloudflare can undo it.
2. Resend status page, https://resend-status.com: an incident on their side.
3. PostHog, Product analytics, Trends: event `auth_email_failed` against `auth_code_sent`, by 5-minute interval, to see when it started. Compare with recent deployments in Vercel, Deployments.

From the Neon console SQL editor of `reranker-prod`, the per-minute counts behind the alert:

```sql
select bucket_start, count, flagged
from ops.velocity_buckets
where key = 'auth.email' and bucket_start > now() - interval '1 hour'
order by bucket_start desc;
```

## Mitigate

1. Key revoked or without access: create a sending-only key restricted to `mail.reranker.co` in Resend, API Keys, and set it as `RESEND_API_KEY` in Vercel Production following [Rotate the auth secrets](auth-rotate-secrets.md). Redeploy production.
2. Domain unverified: in Resend, Domains, `mail.reranker.co`, copy the records it shows into Cloudflare DNS exactly, then click Verify DNS Records.
3. Sending limits: wait for the reset the error names, or move to the plan the [Free tier quota](free-tier-quota.md) runbook names for Resend if the volume is real demand.
4. Resend incident: nothing to change; Google sign-in keeps working. Watch the status page.
5. Our change: roll back in Vercel, Deployments, the previous production deployment, Instant Rollback.

## Verify

Request a code with an address you own wherever the product offers sign-in by code (`/ingresar` while the `accounts` flag is on for you): it arrives within a minute. In PostHog, `auth_email_failed` stops while `auth_code_sent` continues, and `ops.velocity_buckets` for `auth.email` shows `flagged` at 0 in the latest minutes.

## Record

In the alert thread or the pull request: the Resend error, the cause, how long codes were not delivered and the action taken. For alerts, the alert-to-action time target is 15 minutes between 07:00 and 22:00 (Bogota).
