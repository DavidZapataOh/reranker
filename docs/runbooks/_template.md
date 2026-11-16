# Runbook title

<!--
Every file in docs/runbooks has these sections, in this order; `pnpm runbooks:check` enforces it.
Extra sections may follow the last one. Every runbook is registered in `packages/telemetry/src/alerts.ts`
(`opsAlerts`, `externalAlerts` or `procedures`) or in `packages/telemetry/posthog-alerts.json`.
Write steps that can be done from a phone, and never a step that asks anyone to call or meet.
-->

## Trigger

What fires this runbook: the alert kind and its source, or the situation that calls for the procedure.

## Impact

Who or what is affected, and what keeps working.

## Diagnose

The commands or dashboard views that tell the causes apart, each with what it means.

## Mitigate

Numbered steps, in the order they must be done, naming the exact setting to touch in PostHog, Vercel or GitHub.

## Verify

The observable result that proves it is fixed, with how long it takes to show.

## Record

What to write down and where. For alerts, the alert-to-action time target is 15 minutes between 07:00 and 22:00 (Bogota).
