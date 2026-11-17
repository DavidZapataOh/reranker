# Network ranges stale

## Trigger

The `network-ranges-stale` alert (warning, source `jobs`), raised by the `refreshNetworkRanges` step of the daily maintenance run (05:00 Bogota). The payload field `reason` says which guard stopped the refresh:

- `download_failed`: GitHub or the list files could not be fetched and the loaded list is 48 hours old or more (`hours`). Earlier failures only retry.
- `change_too_large`: the new list differs from the loaded one by more than 20% (`current` rows loaded, `incoming` rows offered, upstream `commit`).
- `empty_lists`: every list at that upstream `commit` parsed to nothing.
- `never_loaded`: the download failed and no list was ever loaded.

The lists are `output/datacenter/*` and `output/vpn/*` of `X4BNet/lists_vpn` (MIT, built from IPLocate data, CC BY-SA 4.0), pinned to the commit read at the start of each refresh.

## Impact

Nothing breaks. `classifyNetwork` keeps answering from the loaded list, so datacenter and VPN traffic is still recognised; only networks added upstream since the last good load go unflagged. With `never_loaded` every address classifies as `null`, so callers cannot tell datacenter or VPN traffic apart until a load succeeds.

## Diagnose

From the Neon console SQL editor of `reranker-prod`:

```sql
select source_commit, rows, refreshed_at from ops.network_ranges_meta order by refreshed_at desc limit 3;
select kind, count(*) from ops.network_ranges group by kind;
```

- `refreshed_at` two or more days old and `reason: download_failed`: look for `jobs.daily.step_failed` with `step: refreshNetworkRanges` in PostHog Logs; its `error` names the URL or status. Check https://www.githubstatus.com for an incident.
- `change_too_large`: compare the loaded commit with the new one on GitHub, `https://github.com/X4BNet/lists_vpn/compare/<loaded commit>...<new commit>`, and read the changed line counts under `output/`. A mass removal or a truncated file is an upstream mistake; a large but even change (a new ASN source, many new hosting networks) is real.
- `empty_lists`: open `https://raw.githubusercontent.com/X4BNet/lists_vpn/<commit>/output/datacenter/ipv4.txt`; an empty or HTML body means the upstream output is broken at that commit.

## Mitigate

1. `download_failed` or `empty_lists`: nothing to change. The next daily run retries on its own, and the loaded list keeps serving. If upstream stays broken for a week, open an issue on `X4BNet/lists_vpn`.
2. `change_too_large` that the diff shows is upstream breakage: leave it. The guard keeps the loaded list until upstream recovers.
3. `change_too_large` that the diff shows is real: let the next refresh load it from scratch. In the SQL editor run `delete from ops.network_ranges;` (the guard only compares against a non-empty table; `network_ranges_meta` stays), then rerun the day's maintenance as in step 4. Until the reload finishes, a few minutes, every address classifies as `null`.
4. To rerun the maintenance the same day, release today's claim and trigger the cron (the date is today's in Bogota):

   ```sql
   delete from ops.workflow_starts where kind = 'daily' and key = 'YYYY-MM-DD';
   ```

   ```bash
   vercel crons run /api/cron/daily
   ```

   Every daily step is safe to run twice.

   `vercel crons run` needs a recent Vercel CLI (`vercel crons --help` lists it); otherwise use Vercel, the project, Settings, Cron Jobs, Run. A `401` means the run presented a bearer that does not match `CRON_SECRET`: restore or rotate it as in [Rotate a secret](rotate-secret.md) and redeploy.

## Verify

Within a few minutes of the rerun (or after the next 05:00 run), `jobs.daily.network_ranges` appears in PostHog Logs with `applied: true`, and `ops.network_ranges_meta` has a row with today's `refreshed_at` and `rows` at or above 40,000. No new `network-ranges-stale` follows the next daily run.

## Record

In the pull request or issue that tracks it: the alert time, the `reason`, the loaded and new commits, the decision taken (wait or reload) and the row counts before and after.
