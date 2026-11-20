# DataForSEO capture errors, balance and parsing

## Trigger

One of three alerts (source `capture`), raised by `recordCaptureCall` in `@reranker/capture` after each DataForSEO call:

- `capture-dataforseo-errors` (warning): more than 20% of DataForSEO calls failed in the last 10 minutes, with at least 20 calls in the window. A failure is any call that did not succeed: an error code in the body, a non-200 status, a timeout at 115 seconds or no response at all. The payload carries `calls_10m` and `failed_10m`.
- `capture-dataforseo-balance` (critical): one call came back with 40200 (payment required), 40203 (cost limit exceeded) or 40210 (insufficient funds). The payload carries `engine` and `provider_status_code`.
- `capture-parse-failed` (warning): more than 5% of the DataForSEO calls that returned a body in the last 10 minutes could not be parsed into an answer, with at least 20 calls. The payload carries `calls_10m` and `parse_failed_10m`.

The rate alerts fire once, on the call that crosses the threshold; they fire again only after the rate drops below it and crosses it again.

## Impact

Failed slots are retried once while the report's cut allows it; what still fails leaves the free report partial for that engine, and the canary series misses those points. A balance error stops every DataForSEO capture (Gemini, Google AI Overview, Google AI Mode and the ChatGPT fallback) until the account is funded.

Parse failures lose nothing: the exact response bytes are sealed with every capture, and the answer can be derived again from them once the parser is fixed. Captures from Bright Data and OpenAI are unaffected.

## Diagnose

From the Neon console SQL editor of `reranker-prod`, the last 15 minutes by engine and outcome:

```sql
select engine, status, count(*)
from public_panel.captures
where captured_at > now() - interval '15 minutes'
group by 1, 2
order by 1, 2;

select engine, provider_status_code, http_status, count(*)
from public_panel.captures
where captured_at > now() - interval '15 minutes' and status <> 'succeeded'
group by 1, 2, 3
order by 4 desc;
```

- 40200, 40203 or 40210: the account balance or its spending limit. Check the balance in the DataForSEO dashboard (https://app.dataforseo.com, Balance), or with the `user_data` endpoint of the Appendix API.
- 40202 or 40209: DataForSEO rate limits; the calls are retried after 5 seconds. Persisting means our concurrency is above the account's limit (`DATAFORSEO_MAX_IN_FLIGHT`).
- 50000, HTTP 5xx, timeouts or no response: an outage on their side. Check https://status.dataforseo.com; the breaker opens on its own (see [Provider breaker open](jobs-breaker-open.md)).
- One engine only, status `succeeded` but no answer stored: DataForSEO changed that endpoint's response format. The same shows in PostHog (Product analytics, Trends on `capture_call` with `parse_failed = true`, breakdown by `engine`).

  ```sql
  select engine, count(*) filter (where normalized_sha256 is null) as unparsed, count(*)
  from public_panel.captures
  where captured_at > now() - interval '15 minutes' and status = 'succeeded' and provider = 'dataforseo'
  group by 1;
  ```
- 401xx or 40501, 40503, 40506: our request or our credentials are wrong; look for a recent deployment in Vercel.

## Mitigate

1. Balance: top up the account in the DataForSEO dashboard (Balance, Add funds), or raise its spending limit if 40203. Captures recover on the next call, with no deploy.
2. Outage or a problem limited to one engine that cannot be fixed now: close the narrowest switch as in [Disable a capture channel](disable-capture-channel.md): `capture-engine-<engine>` for one engine, `capture-provider-dataforseo` for all of them.
3. Our bug (bad request, rotated credentials): roll back the deployment in Vercel (Deployments, the previous production deployment, Instant Rollback) or restore `DATAFORSEO_LOGIN` and `DATAFORSEO_PASSWORD` in Vercel, Settings, Environment Variables.
4. Format change: fix the engine's parser against the new bytes, raise its number in `PARSER_VERSIONS` (`packages/capture/src/answer.ts`), ship it, then run `reparse` for the captures stored since the change; their raw bytes are untouched and the new answer is sealed beside the old one.

## Verify

The second query above shows only `succeeded` rows for captures after the fix, within a minute of it; in PostHog, `capture_call` events show `status = succeeded` and `parse_failed = false` again for the engine. After a top-up, the next DataForSEO capture succeeds.

## Record

In the alert email or the pull request that fixes it: the alert, the codes seen, the cause (balance, provider incident, format change or our change), the action taken and the time it recovered. For alerts, the alert-to-action time target is 15 minutes between 07:00 and 22:00 (Bogota).
