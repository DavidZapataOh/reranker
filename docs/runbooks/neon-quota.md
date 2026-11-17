# Neon quota

## Trigger

- The `neon-quota` alert from the daily digest: warning at 70 %, critical at 100 % of the monthly Neon budget (`NEON_MONTHLY_BUDGET_USD`, US$60 when unset), or
- the `neon-quota` alert from a `db_compute_unavailable` event (Postgres `53300` or `57P03` through the application pools), or
- Neon's own spending notification email at 80 % and 100 % of the threshold set in the console (Launch and Scale only, https://neon.com/docs/introduction/spending-notifications).

Since 2026-11-16 the organization is on Launch. Launch has no allowance that runs out: compute is billed at US$0.106 per CU-hour and storage at US$0.35 per GB-month, with no monthly minimum (https://neon.com/docs/introduction/plans, read 2026-11-17). The digest therefore watches money: it reads the month so far from the usage-based consumption endpoint (`/consumption_history/v2/projects`, daily granularity, https://neon.com/docs/guides/consumption-metrics) for both projects and prices compute, root and child storage, instant restore history, snapshots, extra branches and public transfer at the plan's rates (https://neon.com/docs/introduction/usage-calculations), then compares the sum with the budget. Production always on at 0.5 CU is about US$39 a month on its own.

## Impact

On Launch nothing is suspended for usage: crossing a threshold means the month's bill grows past what was planned, not that the product stops. The availability failures that remain are a compute that cannot start (`53300`, `57P03`) and a move back to the Free plan, where the Free limits apply again (https://neon.com/docs/introduction/plans, "What happens if I exceed my Free plan limits"):

- Out of CU-hours: the compute is suspended until the next billing period or until the plan changes. Every query and `pg_dump` fails, so the whole product is down for anything that touches the database. Data is not deleted.
- Over 1 GB of storage: the compute stays up and reads work, but statements that grow storage (inserts, updates, deletes) fail until space is freed or the plan changes.

`reranker-nonprod` spending only affects previews and CI; `reranker-prod` is customer traffic.

## Diagnose

```bash
NEON_API_KEY=<key> pnpm --filter @reranker/db db:usage --project <project id>
```

The JSON gives the month so far per project: `computeHours`, `storageGbMonths` and `spendUsd`, the same figures the digest reports. Reading it does not wake the compute. Project ids are in the Neon console, Settings, General. The digest reads both projects with the Production variables `NEON_API_KEY`, `NEON_PROJECT_ID` and `NEON_NONPROD_PROJECT_ID`; the console's Billing page shows the exact amount so far.

- `computeHours` of `reranker-prod` near 0.5 CU × the hours elapsed: the expected always-on baseline. Well above it: load keeps the compute scaled up; check the Monitoring tab and `pg_stat_activity` for a client that polls.
- `computeHours` of `reranker-nonprod` high: previews or CI branches left running. Delete leftover `ci/*` branches.
- `storageGbMonths` high: look for the largest tables in the console, Tables view, or with `select pg_size_pretty(pg_total_relation_size(oid)), relname from pg_class order by pg_total_relation_size(oid) desc limit 10;`.

## Mitigate

1. At 70 %: remove the cause if there is one (leftover `ci/*` branches in `reranker-nonprod`, a polling client, a large table that should hold no raw data) and check the trend against the days left in the month.
2. At 100 %: decide whether the spend buys something the product needs. If it does, raise `NEON_MONTHLY_BUDGET_USD` in Vercel (Settings, Environment Variables, Production) and the spending notification threshold in the Neon console (Billing) together, with the reason. If it does not, remove the cause before the month closes. Never turn scale to zero back on in production: `launch:check` requires it off.
4. If the organization is back on Free and a compute is suspended: return it to Launch in the Neon console, Billing, Change plan (https://neon.com/docs/introduction/manage-billing#change-your-plan). Connection strings do not change, and a restart picks up the new limits.

## Verify

The next daily digest shows the estimated spend under the threshold and carries no `neon-quota` alert, a fresh query through the application succeeds (`curl -s https://reranker.co/api/health` stays database-free, so run a real request that reads data).

## Record

Date, project, threshold crossed, the cause found, the budget before and after, and the amount billed that month.
