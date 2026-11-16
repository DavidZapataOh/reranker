# Flags not ready

## Trigger

The `flags-not-ready` alert (critical, source `flags`): an instance has gone more than 5 minutes without the feature flag definitions from PostHog. The first evaluation after the five minutes raises it, and it repeats at most once an hour while the definitions stay missing. In production it is also emailed to `alertas@reranker.co`, once per hour, with a link to this file. The payload field `since` is when the instance first found the definitions missing.

## Impact

Kill switches fail closed. With no definitions every flag reads off, so `assertCaptureAllowed` throws `FlagsNotReadyError` (retryable, retry after 30 s) and `captureSwitchSnapshot` throws the same error. Capture of answers stops for as long as the definitions are missing; nothing else in the product reads a flag today. Reports already stored and the landing keep working. Nothing is lost: capture resumes by itself at the next successful poll, which runs every 30 seconds.

Dependency not shipped yet: `assertCaptureAllowed` has no caller in the application until the capture engine ships, so today the alert is the only visible symptom.

## Diagnose

Start from the cause that is cheapest to rule out.

1. The deployment started without the key. `POSTHOG_FEATURE_FLAGS_KEY` is required in production, so a missing one fails the deploy; for preview and local runs it is absent by design and flags always read off, with no alert expected.

   ```bash
   vercel env ls production
   ```

   Look for `POSTHOG_FEATURE_FLAGS_KEY`, `POSTHOG_PROJECT_TOKEN` and `POSTHOG_HOST`. Names only; the command never prints values.

2. The key was revoked or has lost its scope. In PostHog, open Project settings, then Project secret API key, and confirm the key exists and has `feature_flag:read`. A key rotated in PostHog without updating Vercel looks exactly like this (see `rotate-secret.md`).

3. PostHog itself is failing. Open `https://status.posthog.com` and check for an incident on US Cloud or on feature flags.

4. Check the endpoint with the production key, exported in the shell without echoing it:

   ```bash
   curl -s -o /dev/null -w '%{http_code}\n' \
     -H "Authorization: Bearer $POSTHOG_FEATURE_FLAGS_KEY" \
     https://us.i.posthog.com/flags/definitions
   ```

   `200`: the key and PostHog are fine, so the instance did not load them (redeploy to restart it). `401` or `403`: the key is wrong or lacks the scope. `5xx` or a timeout: PostHog is failing.

5. Logs: the `ops.alert` line with `kind: flags-not-ready` in PostHog Logs (or `vercel logs <production deployment url>`) shows when it started and on which instances.

## Mitigate

1. If the key is missing or wrong, create or copy the project secret key in PostHog (Project settings, Project secret API key) with the `feature_flag:read` scope, then set it in Vercel as `POSTHOG_FEATURE_FLAGS_KEY`, type Secret, Production only.
2. Redeploy production so every instance starts with it (Vercel, Deployments, the latest production deployment, Redeploy).
3. If PostHog is down, there is nothing to change: the switches stay closed and capture resumes at the next poll after PostHog recovers. Do not open a switch by any other means; the closed state is the safe one.

## Verify

Within 60 seconds of the redeploy or of PostHog recovering, the endpoint check returns `200` and no new `flags-not-ready` appears in the following hour. Once a capture runs again, the log line `capture.blocked` stops appearing for channels that are switched on.

## Record

In the alert email thread or in the pull request that fixes it: when the alert fired, the cause (key, scope, PostHog or deployment) and the time capture was allowed again. If a key was rotated, record it where `rotate-secret.md` asks.
