# Free tier quota

## Trigger

- The `free-tier-quota` alert from the daily digest (warning at 50% and 80%, critical at 95%) for GitHub Actions, PostHog or Resend, or
- a provider email from one of the native alerts below, or
- a provider rejecting requests with a quota or spend error.

Neon compute is covered by `neon-quota` and Vercel Workflows usage by `jobs-hobby-quota`; both runbooks belong to other plans and are not repeated here.

Limits and menu paths below were read from each provider's official documentation on 2026-11-16. Provider limits change; re-read the linked page before relying on a number.

## Impact

Each source fails differently, which decides how urgent the response is.

| Source | Setup status | Free limit (as of 2026-11-16) | What happens at the limit |
|---|---|---|---|
| PostHog | To configure now | Free plan: 1M analytics events, 100K exceptions, 1M feature flag requests, 10 GB logs, per month | Ingestion stops. Data beyond the limit is lost. Flags return their default (quota limited) value, so kill switches stay closed. |
| GitHub Actions | To configure now | Included compute usage per month, as a dollar amount: $12 (Free), $18 (Pro or Team). About 2,000 Linux minutes on Free | With no payment method, usage is blocked until the next billing cycle. |
| Vercel Hobby | To configure now | Per month: 1M function invocations, 4 Active CPU hours, 1M CDN requests, 100 GB Fast Data Transfer, 50K Web Analytics events | The feature is unavailable for 30 days (Web Analytics 7 days). Production can stop serving. |
| Google Cloud (Places API) | Pending until the account exists | Text Search Pro: 5,000 free billable events per month, then $32 per 1,000 | Budget alerts only notify. A per-day quota is the hard cap: requests fail until midnight Pacific. |
| OpenAI | Pending until the account exists | No free tier. Spend is limited by the monthly project limit and the approved usage limit | With "Enforce a hard limit" on, requests return `429`. With only an alert, traffic continues. |
| DataForSEO | Pending until the account exists | No free tier beyond a $1 trial credit. Prepaid balance, $50 minimum top-up, no expiry | Requests fail when the balance is empty. No automatic recharge is configured. |

## Diagnose

```bash
gh api /users/DavidZapataOh/settings/billing/usage
```

For the other sources read the daily digest first; it lists Actions minutes, PostHog usage, the DataForSEO balance and per-provider spend. Then open the provider dashboard named in each section.

## Mitigate

### PostHog

- Limit: https://posthog.com/pricing (accessed 2026-11-16).
- Where: PostHog organization billing settings. At the bottom of each product, under the billing limit section, click "Set billing limit", enter a dollar limit and save. Repeat per product (analytics, error tracking, feature flags, logs). Source: https://posthog.com/docs/billing/limits-alerts (accessed 2026-11-16).
- Alert behavior: the organization owner receives emails at 80% and 100% of the free allotment, and at 80% and 100% of any billing limit set. A billing limit is a hard cap: PostHog stops ingesting and processing, and the extra data is lost. Logs custom retention cannot have a limit.
- Setup: on the Free plan usage already stops at the free limits, so the alert emails are the only item to confirm.
- Mitigation when it fires: sample or drop noisy events at the client, lower `capture_exceptions` volume by fixing the repeating error, and rely on the fail-closed flag default meanwhile. Wait for the monthly reset; do not add a card without a reason that meets the spending rule.

### GitHub Actions

- Limit: https://docs.github.com/en/billing/concepts/product-billing/github-actions (accessed 2026-11-16).
- Where, usage alert: github.com Settings, Billing and licensing, Budgets and alerts, then under "Included usage alerts" select "Receive alerts when my included usage reaches 90% and 100%". Source: https://docs.github.com/en/billing/how-tos/set-up-budgets (accessed 2026-11-16).
- Where, workflow failures: Settings, Notifications, under System choose Actions, set the dropdown to "Email" and "Only notify for failed workflows", then Save. Source: https://docs.github.com/en/subscriptions-and-notifications/how-tos/managing-github-actions-notifications (accessed 2026-11-16).
- Alert behavior: email only. The block itself happens when the included usage is consumed and no payment method exists.
- Mitigation when it fires: follow `ci-minutes-exhausted.md`.

### Vercel Hobby

- Limit: https://vercel.com/docs/plans/hobby (accessed 2026-11-16).
- Where: switch to the team, Settings, Account, My Notifications. Keep email enabled for "Deployment Failures", "Usage increased" and "Usage limit reached". Source: https://vercel.com/docs/notifications (accessed 2026-11-16).
- Alert behavior: email and dashboard only. Usage notifications cannot be customized on Hobby (customization is Pro); "Usage increased" and "Usage limit reached" are critical notifications, so email cannot be disabled together with the web channel. There is no spend cap on Hobby: exceeding a limit pauses the feature for 30 days.
- Mitigation when it fires: identify the exhausted resource in the Vercel Usage tab, remove the cause (cache more, cut invocations, disable the feature), and reduce the same resource in the daily digest. Pro is deliberately postponed to the founder's sale #10 trigger; before that, degrade with notice instead of upgrading.

### Google Cloud (Places API)

- Limit: Places API Text Search Pro, 5,000 free events per month per SKU, $32 per 1,000 after. Source: https://developers.google.com/maps/billing-and-pricing/pricing (accessed 2026-11-16).
- Where, budget: Google Cloud console, Billing, Budgets & alerts, Create budget. Default thresholds are 50%, 90% and 100% of actual spend; keep them. Source: https://cloud.google.com/billing/docs/how-to/budgets (accessed 2026-11-16).
- Where, daily cap: Cloud console, the Quotas page, select the Places API Text Search quota and edit it. Google's rule is to divide the SKU's free cap by 31 and round down: 5,000 / 31 = 161 requests per day. Use 161, not 166 (5,000 / 30), so a 31-day month stays under the free cap. Source: https://developers.google.com/maps/billing-and-pricing/manage-costs (accessed 2026-11-16).
- Alert behavior: the budget is alerts only and never stops usage. The per-day quota is the hard cap; requests fail for the rest of the day and the quota resets at midnight Pacific. Quota alerts are a separate setting and notify before the limit.
- Mitigation when it fires: turn off `places-resolution` in PostHog (it disables the `google_places` provider), check the Quotas page for the cause, and raise the quota only for a measured need.

### OpenAI

- Where: create one project for production and one for tests. For each: Project settings, Limits, Spend, "Edit spend limit", enter the monthly spend limit, turn on "Enforce a hard limit" if it should cut, Save. Add spend alerts at lower thresholds. Source: https://developers.openai.com/api/docs/guides/spend-limits (accessed 2026-11-16).
- Alert behavior, per the docs: a spend alert only notifies and traffic continues; a hard spend limit makes affected requests return `429` with `project_spend_limit_exceeded` (organization level: `organization_spend_limit_exceeded`). Enforcement is not instantaneous, so recorded spend can slightly exceed the limit. OpenAI also applies its own approved usage limit by tier (`organization_usage_limit_exceeded`), and exhausted prepaid credits return `credit_balance_exhausted`. The older `insufficient_quota` code is not the documented signal for spend limits.
- Community reports say some projects kept serving requests after a budget, so the docs are not enough on their own.
- Mitigation when it fires: read `error.code`, then raise or remove the limit if traffic should resume (it propagates after the update), or wait for the monthly reset. Turn off `capture-provider-openai` in PostHog to stop calls cleanly while deciding.

TODO (recorded verification, not done until the account exists): in the tests project set the limit to current spend plus US$0.01 with "Enforce a hard limit" on, make one minimal call, and record here the HTTP status, the `error.code` and the date. Expected per docs: `429` with `project_spend_limit_exceeded`. Result: pending.

### DataForSEO

- Limit: pay as you go, $50 minimum top-up, balance never expires, $1 trial credit for new accounts. Source: https://dataforseo.com/pricing (accessed 2026-11-16).
- Where, automatic recharge: Dashboard, Add Funds. Automatic recharge only exists if someone creates it there ("Create Auto Recharge"); confirm none is configured. Source: https://dataforseo.com/help-center/set-auto-recharge (accessed 2026-11-16).
- Where, daily limit: Dashboard, API Settings, daily expenses limit per API or endpoint (UTC day). Source: https://dataforseo.com/update/daily-expenses-limits (accessed 2026-11-16).
- Alert behavior: DataForSEO emails when five to one days of API use remain, based on average spending. The prepaid balance is the hard cap; the daily limit returns a cost-limit error.
- Mitigation when it fires: top up manually with the amount the daily digest projects, or turn off `capture-provider-dataforseo` to degrade with notice.

## Verify

- Each configured dashboard shows its alert or limit saved; store a screenshot per source with the date in the verification record.
- `gh api /users/DavidZapataOh/settings/billing/usage` and the next daily digest show usage under the thresholds.
- After raising or waiting out a limit, one real request to the provider succeeds.

## Record

Date, source, threshold crossed, what was reduced or switched off, and the flag state before and after. For the OpenAI check, the exact status and error code observed.
