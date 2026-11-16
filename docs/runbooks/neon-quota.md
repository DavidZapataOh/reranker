# Neon quota

## Trigger

- The `neon-quota` alert from the daily digest: warning at 50 % and 80 %, critical at 95 % of the Free allowance of a project (100 CU-hours of compute per billing period, 1 GB of Postgres storage), or
- the `neon-quota` alert from a `db_compute_unavailable` event (Postgres `53300` or `57P03` through the application pools), or
- connections failing with SQLSTATE `53000`, which Neon returns when the compute has been suspended for lack of CU-hours.

The daily digest ships with the operations plan (`runDailyDigest`); until it runs, read the usage by hand as shown below. The database error handler does not yet map `53000` to `db_compute_unavailable`, so a suspended compute shows up as a plain `internal` error, not as this alert.

## Impact

Per Neon's documentation (https://neon.com/docs/introduction/plans, "What happens if I exceed my Free plan limits"):

- Out of CU-hours: the compute is suspended until the next billing period or until the plan changes. Every query and `pg_dump` fails, so the whole product is down for anything that touches the database. Data is not deleted.
- Over 1 GB of storage: the compute stays up and reads work, but statements that grow storage (inserts, updates, deletes) fail until space is freed or the plan changes.

`reranker-nonprod` going over only breaks previews and CI; `reranker-prod` going over is customer impact.

## Diagnose

```bash
NEON_API_KEY=<key> pnpm --filter @reranker/db db:usage --project <project id>
```

The JSON gives `computeHours`, `computePct`, `storageBytes` and `storagePct` per project. Reading it does not wake the compute (https://neon.com/docs/guides/consumption-metrics). Project ids are in the Neon console, Settings, General. The Production variables `NEON_API_KEY` and `NEON_NONPROD_PROJECT_ID` that let the digest read both projects are set after this plan merges; until then pass `--project` with the id and a key that can read it.

- `computePct` high and rising: something keeps the compute awake. Check `pg_stat_activity` for a client that polls, and confirm nothing in the product pings the database from a health check; the liveness endpoint is database-free by design.
- `storagePct` high: look for the largest tables in the console, Tables view, or with `select pg_size_pretty(pg_total_relation_size(oid)), relname from pg_class order by pg_total_relation_size(oid) desc limit 10;`. Branches add to the total, so also delete leftover `ci/*` branches in `reranker-nonprod`.

## Mitigate

1. At 50 %: nothing to do except check the trend against the days left in the billing period (`periodEnd` in the JSON).
2. At 80 %: remove the cause if there is one (leftover branches, a polling client, a large table that should hold no raw data). If the projection still crosses 100 % before `periodEnd`, move the project to Launch before it does.
3. At 95 %, or when the compute is already suspended: upgrade the project's organization to Launch in the Neon console, Billing, Change plan (https://neon.com/docs/introduction/manage-billing#change-your-plan). Connection strings do not change, and a restart picks up the new limits. Launch has no minimum monthly fee, and usage is billed per CU-hour and per GB-month, so this is the one spending decision the rule allows here: it buys availability.
4. After the incident decide whether to stay on Launch or return to Free once the period resets. Export data before downgrading, since `pg_dump` counts toward network transfer.

## Verify

`db:usage` shows the new limits applied or the percentage below the threshold, a fresh query through the application succeeds (`curl -s https://reranker.co/api/health` stays database-free, so run a real request that reads data), and the next daily digest carries no `neon-quota` alert.

## Record

Date, project, threshold crossed, the cause found, the plan before and after, and the amount billed if the plan changed.
