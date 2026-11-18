# Uptime down

## Trigger

The `uptime-down` alert, or Better Stack reports the monitor for `https://reranker.co/` or `https://reranker.co/api/health` as down. Better Stack checks both every 3 minutes and opens an incident after two failed checks.

## Impact

Which monitor failed decides the scope:

- Only `/` fails: the landing or the edge rewrite is broken; the application itself may be fine.
- Only `/api/health` fails: the deployment started with an invalid environment (`503`) or the function is crashing.
- Both fail: the whole deployment or Vercel is down, and visitors cannot reach the product.

`/api/health` never touches the database, so a failing check is never caused by Neon.

## Diagnose

```bash
curl -si https://reranker.co/api/health
curl -sI https://reranker.co/
vercel ls --prod
vercel logs <production deployment url>
```

- `503` with `{"status":"env_invalid"}`: a required variable is missing or malformed. The deployment logs name it; the response never does. Check `vercel env ls production` and the last change to it.
- `402` on every URL: Vercel disabled the team (`DEPLOYMENT_DISABLED`), usually for an unpaid invoice. Follow [vercel-billing.md](vercel-billing.md); no rollback or redeploy helps until the bill is paid.
- `200` from curl but Better Stack still red: a regional or DNS problem. Check Vercel's status page and the monitor's regions in Better Stack.
- Timeout or `5xx`: look at the latest deployment and its logs for a crash; compare `version` in a healthy response with the commit last promoted.
- Everything fails right after a deploy: that deployment is the cause.

## Mitigate

- Bad deployment: roll back to the previous production deployment.

```bash
vercel rollback
```

- Invalid environment: restore the variable in Vercel (Production), then redeploy.
- Vercel or DNS incident: nothing to change on our side; wait for the provider and post the status link in the incident.

## Verify

`curl -si https://reranker.co/api/health` returns `200` with `{"status":"ok", ...}` and `version` equal to the commit that should be live, and both Better Stack monitors return to up and close the incident.

## Record

Required for any incident longer than 10 minutes: the cause, the time it started and ended, and the change that fixed it, in the Better Stack incident timeline.
