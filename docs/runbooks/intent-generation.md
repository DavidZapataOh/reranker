# Intent generation falling back to templates

## Trigger

The `intent-generation-template-rate` alert (warning, source `catalog`), raised by `recordIntentSetResolution` in `@reranker/catalog` after a resolution that tried to generate an intent set. It fires when more than 10% of those attempts in the last 10 minutes ended in the reviewed templates, with at least 20 attempts in the window. The payload carries:

- `language`: the measurement language whose own window crossed the threshold (`es`, `en`, `pt`, `fr`, `de`, `it`), or `all` when the rise is spread across languages and only the overall window crossed it.
- `attempts_10m` and `templates_10m`: the window behind the alert.

The alert fires once, on the attempt that crosses the threshold, and again only after the rate drops below it and crosses it again. Seeds, reused sets, templates served with the `intent-generation` switch off, languages without reviewed prompts, and waiters that took the template of a concurrent caller are not attempts and never count.

This is also the procedure for turning the `intent-generation` kill switch off and on, and for forcing a category to generate a new set.

## Impact

Nothing fails. A report whose category is outside the seed and has no set from the last 30 days gets the archetype's reviewed templates in its language instead of generated questions: fewer paraphrases per intent and no personas, so its measurement is coarser. Seed categories and categories with a stored set are unaffected. Templates are never reused by key, so each new request for that category tries to generate again once the cause is gone.

## Diagnose

In PostHog (project 711803, SQL editor), the last hour of resolutions by language, outcome and fallback reason:

```sql
select properties.language as language, properties.outcome as outcome,
       properties.fallback as fallback, count() as resolutions,
       round(avg(toFloat(properties.generation_ms))) as generation_ms,
       sum(toFloat(properties.cost_micros)) / 1e6 as usd,
       round(avg(toFloat(properties.guard_rejects))) as guard_rejects,
       round(avg(toFloat(properties.judge_rejects))) as judge_rejects
from events
where event = 'intent_set_resolved' and timestamp > now() - interval 1 hour
group by language, outcome, fallback
order by language, resolutions desc
```

From the Neon console SQL editor of `reranker-prod`, the sets stored in the last hour:

```sql
select language, kind, count(*)
from public_panel.intent_sets
where created_at > now() - interval '1 hour'
group by 1, 2
order by 1, 2;
```

What the fallback reason means:

- `incomplete` with generation near 9 to 12 seconds and low cost: a provider is slow or down. Check https://status.openai.com and https://aistudio.google.com/status, and whether a breaker opened ([Provider breaker open](jobs-breaker-open.md)) or calls wait for a slot ([Provider saturated](jobs-provider-saturated.md)). A spend cap that rejects reservations also ends here ([Spend cap reached](jobs-spend-cap-reached.md)).
- `incomplete` with normal cost and high `guard_rejects` or `judge_rejects` in one language: the models stopped following that language's prompts (a model update, or a prompt change just deployed). Compare the language with the others in the first query.
- `no_time`: generation started with under a second of budget, or a waiter's deadline passed while another caller was still generating. The report workflow reaches this step late; look at how long the steps before `prepare` took in the free report's workflow run in Vercel.

## Mitigate

1. Provider outage: turn off the `intent-generation` kill switch so requests stop spending on calls that will not finish. In PostHog, Feature flags, search `intent-generation`, open it and turn off the Enabled toggle; do not edit its release conditions. Instances see it within about 30 seconds. Seeds, stored sets and templates keep serving every report, and templates served while it is off do not count toward this alert.
2. One language regressed after a deploy: roll back in Vercel (Deployments, the previous production deployment, Instant Rollback), then fix the prompts of that language in `packages/catalog/src/generate/prompts`. Changing a language's prompts changes its config hash, so its next request generates a new set and the other languages keep theirs.
3. Spend cap: follow [Spend cap reached](jobs-spend-cap-reached.md); generation resumes once reservations succeed.
4. When the cause is fixed, turn `intent-generation` back on in PostHog the same way.

To force one category to generate again (a stored set turned out wrong), make it older than the 30-day reuse window from the Neon console of `reranker-prod`. The set itself, its artifact and every report that used it stay intact; only reuse stops picking it:

```sql
update public_panel.intent_sets
set created_at = created_at - interval '31 days'
where category_key = '<category key>' and kind = 'generated'
  and created_at > now() - interval '30 days';
```

The next request for that category, scope, register profile and language generates a new set.

## Verify

Within 10 minutes of the fix, the first query shows `generated` outcomes again for the language, with `fallback` null, and no new `template` rows with `incomplete` or `no_time`. After turning the switch back on, the next resolution of a category without a stored set logs `catalog.intent_set.resolved` with `outcome` `generated` (PostHog Logs, or `vercel logs <production deployment url>`).

## Record

In the alert email or the pull request that fixes it: the language, the fallback reasons seen, the cause (provider incident, prompt or model change, spend cap or a slow workflow step), the time the switch was turned off and on, and any category forced to regenerate. For alerts, the alert-to-action time target is 15 minutes between 07:00 and 22:00 (Bogota).
