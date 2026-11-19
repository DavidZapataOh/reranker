# Transparency log fork

## Trigger

The `evidence-log-fork` alert (critical, source `evidence`). The publisher raises it when an object of the log bucket (`rr-log-<env>`) already holds other bytes than the ones Postgres derives for it, or when the published tiles do not lead to the root a batch signed. The payload names the `origin` and the object `key`.

## Impact

Publication stops at the last good checkpoint, and integration refuses to sign new checkpoints until that batch is public, so sealing keeps working and every new entry waits in the queue: nothing is lost. Bundles of captures sealed since then have no inclusion proof yet. A served tile is a public commitment: anyone who fetched it can prove what the log said.

## Diagnose

Compare the public log with Postgres. Read the served checkpoint and the latest batches, from the Neon console SQL editor of the affected project:

```bash
curl -s https://log.reranker.co/captures/2026/checkpoint
```

```sql
select tree_size, encode(root, 'base64') as root, created_at, published_at
from public_panel.evidence_batches
where origin = 'log.reranker.co/captures/2026'
order by tree_size desc limit 5;
```

- Preview (`log-preview.reranker.co`): every preview deployment branches Postgres but shares `rr-log-preview`, so two branches that integrated different entries collide. Expected there; no customer reads the preview log.
- Production, and the served checkpoint names a size or root that Postgres does not have: Postgres went back in time (a restore or a branch reset) after the log published. The served objects are the truth.
- Production, and Postgres has the served checkpoint but the object at `key` differs: something other than the publisher wrote to the bucket. Check the bucket's audit log in Cloudflare (Manage account, Audit logs) for writes with another token.

## Mitigate

1. Preview: in Cloudflare, R2, `rr-log-preview`, delete the objects under the alerted origin's path, then let the next integration republish them.
2. Production: never delete or overwrite a served object; it would break every proof already handed out.
3. Production, Postgres went back in time: create a Neon branch at a point after the last served checkpoint (Branches, Create branch, past point in time) and copy back the `evidence_batches`, `evidence_entries` and `captures` evidence rows it has and the main branch lost. Publication resumes on the next integration.
4. Production, a foreign write: revoke the token that wrote it (Cloudflare, My Profile, API Tokens) and rotate `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY` (see `rotate-secret.md`); then treat the object as in step 3, comparing it with the batch Postgres signed.

## Verify

Within two minutes of the fix the served checkpoint grows to the latest batch and `published_at` is set on every batch; no new `ops.alert` with `kind: evidence-log-fork` appears in the logs.

## Record

Date, environment, origin and key, which copy was right and why, and every object or row touched. For the alert-to-action target see the template: 15 minutes between 07:00 and 22:00 (Bogota).
