# Provider breaker open

## Trigger

The `jobs-breaker-open` alert (critical, source `jobs`), raised by `breakerCheck` when a provider's circuit breaker has not closed for more than 5 minutes since it opened. It alerts at most once an hour per provider and account across every instance. The payload carries `provider`, `account` (`default` unless the provider has several) and `open_minutes`.

The breaker opens when the last 60 seconds hold at least 20 calls and half of them or more failed (5xx, timeouts and the provider's own outage codes). It stays open 30 seconds, then lets one probe call through: a success closes it, a failure reopens it for another 30 seconds. More than 5 minutes means about ten probes in a row failed.

## Impact

Every call to that provider is refused before it goes out (`ProviderUnavailable`), so nothing is spent on it and steps retry after the open window. Work that needs the provider waits; reports that depend on it are late. Other providers are unaffected.

## Diagnose

From the Neon console SQL editor of `reranker-prod`:

```sql
select provider, account, opened_at, open_until, probe_until, now() - opened_at as open_for
from ops.breaker_state
where opened_at is not null;

select bucket_start, calls, failures
from ops.breaker_windows
where provider = '<provider>'
order by bucket_start desc;
```

- The provider's status page reports an incident (for OpenAI, https://status.openai.com): an outage on their side; the breaker is doing its job.
- No incident, and the failures started with a deployment of ours: a bad request or expired credentials that the adapter counts as failures. Look at `jobs.breaker.state` events in PostHog (Product analytics, Trends, breakdown by `provider` and `state`) next to the deployment time in Vercel, and at the adapter's error logs in PostHog Logs.
- `probe_until` in the future and `open_until` in the past: a probe is out now; wait for its outcome.

## Mitigate

1. Provider outage: nothing to force. The breaker keeps probing every 30 seconds and closes on the first success. If the outage will last hours, close the provider's capture switch as in [Disable a capture channel](disable-capture-channel.md), so work stops retrying and is told the channel is off; reopen it when the provider recovers.
2. Our bug (bad request, rotated or expired key): fix the cause first, by rolling back the deployment (Vercel, Deployments, the previous production deployment, Instant Rollback) or by restoring the credential in Vercel, Settings, Environment Variables. The next probe then succeeds and closes the breaker on its own.
3. Only when the cause is fixed and waiting for the next probe is not acceptable, close the breaker by hand:

   ```sql
   update ops.breaker_state set open_until = null, probe_until = null, opened_at = null
    where provider = '<provider>' and account = '<account>';
   delete from ops.breaker_windows where provider = '<provider>' and account = '<account>';
   ```

## Verify

A `jobs.breaker.state` event with `state: closed` for the provider appears in PostHog, `ops.breaker_state` shows `opened_at` empty for it, and calls to the provider succeed again within a minute.

## Record

In the alert thread or the pull request that fixes it: the provider, how long the breaker stayed open, the cause (provider incident or our change) and the action taken. For alerts, the alert-to-action time target is 15 minutes between 07:00 and 22:00 (Bogota).
