# Disable a capture channel

## Trigger

The `capture-channel-disabled` alert (info, source `flags`), or any decision to stop capturing from one channel, provider or engine at once: a provider terms or legal issue, a runaway cost, a vendor incident, or a channel returning bad data. It is also the procedure to turn a channel back on.

Dependency not shipped yet: nothing in the code raises `capture-channel-disabled` today, and `assertCaptureAllowed` has no caller until the capture engine ships. The kill switches already exist in PostHog and in `packages/flags/registry.json`; this runbook is how to operate them.

## Impact

Closing a switch stops every new capture that goes through it, within about a minute and without a deploy. Work in flight finishes; the next attempt throws `CaptureChannelDisabledError` (not retryable) and is logged as `capture.blocked`. A capture needs all of its switches on: the channel, the provider and, when the capture names one, the engine. Closing any one of them blocks it.

Reports already stored are untouched.

## Diagnose

The switches, as flag keys in PostHog (Feature flags, search `capture-`):

- Channels: `capture-channel-ui-vendor`, `capture-channel-api`. `capture-channel-ui-own` is closed in code whatever its value; do not enable it.
- Providers: `capture-provider-dataforseo`, `capture-provider-openai`, `capture-provider-brightdata`. These are on only where the evaluating environment is production.
- Engines: `capture-engine-chatgpt`, `capture-engine-gemini`, `capture-engine-google-ai-overview`, `capture-engine-perplexity`.

Pick the narrowest switch that stops the problem: one engine for a bad answer source, one provider for a vendor problem, one channel for everything that goes through a path. A switch is positive: enabled means allowed, disabled means blocked. Flags created by `flags:sync` start disabled, so a switch that was never turned on is already closed.

## Mitigate

From the PostHog web app on a phone or a computer, project 711803:

1. Open Feature flags and search for the key.
2. Open the flag and turn off the Enabled toggle at the top (disabled flag). Do not edit the release conditions; the toggle is the switch.
3. Save. The change is live in PostHog at once.

Instances pick it up on their next poll of the definitions, which runs every 30 seconds, so the longest it takes to reach every instance is about 30 seconds.

To turn the channel back on, turn Enabled on again and verify the same way. Do not delete a flag: `pnpm flags:check` fails in CI when a flag in the registry is missing from PostHog.

## Verify

Within 60 seconds of saving:

1. In PostHog Logs (or `vercel logs <production deployment url>`), the next capture attempt through that switch logs `capture.blocked` with `flags` naming the key and the capture failing with `CaptureChannelDisabledError`.
2. When capture has shipped, every capture batch stores the output of `captureSwitchSnapshot`: `switches[<key>]` is `false`, `evaluatedAt` is after the change and `definitionsEtag` differs from the one before. A batch created after the change is the proof that the instance that ran it saw the closed switch.

If neither appears after 60 seconds, check that the key is spelled exactly as above and that the flag is the one you toggled, then wait one more poll (30 seconds). If instances still do not see it, follow `flags-not-ready.md`: an instance without definitions fails closed anyway, so the capture is blocked either way.

## Record

In the alert email or the pull request that follows: the key switched, the time it was closed, the reason, and the time it was verified. When turning it back on, the time and what changed.
