# Engine model change

## Trigger

The `model-change` alert (warning, source `capture`), raised by `recordModelSeen` in `@reranker/capture` when a stored capture reports a model other than the one of the current regime for its engine, channel and provider, and was taken at or after that regime opened. The payload carries `engine`, `channel`, `provider`, `from` (the previous model, or `none`) and `to`. The change also emits the `regime_opened` event and is signed and queued for the transparency log as a `regime` entry.

It fires once per change: concurrent captures of the new model open a single regime, and a capture collected late from a provider queue with the old model never reopens the previous one.

## Impact

Nothing fails and every capture keeps being stored. Answers before and after the change come from different models, so comparisons that span the change (a remeasurement against an earlier report, the canary series of that engine) are not like for like until they are marked with the regime.

## Diagnose

From the Neon console SQL editor of `reranker-prod`, the last regimes of every engine:

```sql
select engine, channel, provider, cause, model_reported, opened_at, last_seen_at, capture_count,
       envelope_sha256 is not null as signed
from public_panel.model_regimes
order by opened_at desc
limit 20
```

- A new regime with a growing `capture_count` and the old one no longer seen: the provider moved to the new model for good.
- The old model still seen after the new regime opened (its captures keep arriving and are dropped as late): the provider is serving both, typically during a gradual rollout. Wait a day before treating it as final.
- `signed` false an hour after the alert: signing or the log failed; search the logs for `capture.model_regime_failed`.

In PostHog (project 711803), the `regime_opened` events of the last week show how often each engine changes.

## Mitigate

1. Nothing has to be switched off: reports keep their captures, and each capture keeps its own reported model in its signed statement.
2. Reports compare across the change only through `currentRegime`, which returns the regime and the date since it holds; check that the report or remeasurement in question starts after `opened_at`, or that it labels the change.
3. If the change is on the OpenAI control channel (`channel` = `api`), the frozen profile pins the requested model, so the change came from OpenAI's side of the same model name. If a new model or parameter is wanted instead, ship it as profile `control-chatgpt@2`; never edit `@1`.
4. If `signed` is false, the regime row exists but its envelope is missing: open an issue with the regime id; nothing else depends on the envelope yet.

## Verify

The new regime is the latest row for that engine, channel and provider, its `capture_count` grows with each capture, and `envelope_sha256` is set. The next captures of the same model raise no further alert.

## Record

Note the engine, channel, provider, both models and `opened_at` in the operations log, with whether the change was final or a rollout. Alert-to-action time target: 15 minutes between 07:00 and 22:00 (Bogota).
