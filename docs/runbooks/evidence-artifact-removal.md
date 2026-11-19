# Evidence artifact removal

## Trigger

A request that arrives at privacy@reranker.co (personal data) or legal@reranker.co (a court or authority order) and asks to take down an AI answer or its extraction because it names a person. Under the data policy (`/politica-de-datos`, "Cómo ejercer tus derechos") the claim is marked "reclamo en trámite" within 2 business days and resolved within 15.

## Impact

The person's name stays public at `ev.reranker.co/raw/<sha256>` (and `normalized/`) until the artifact is removed. Removal deletes the bytes from R2, purges the CDN copy, and records the removal in `public_panel.artifact_removals`, which is append-only. The signed statement, the log entry and the anchors keep only the digest, so every bundle of that capture still verifies its signature, inclusion and date, and shows the artifact as `removed` with the date and reason. Nothing else about the capture changes, and reports that cited it keep working.

## Diagnose

1. Identify the requester: name, identification number and a reply address, or the order with its issuing authority. Someone acting for another person attaches the document that authorizes them. If something is missing, ask for it by email within 5 business days.
2. Find the capture: the requester sends the verify link (`reranker.co/verificar/<capture_id>`) or the report where it appeared. The bundle at `/api/evidence/bundles/<capture_id>` lists `artifacts.raw.sha256` and `artifacts.normalized.sha256`.
3. Confirm the person appears in the text: open `https://ev.reranker.co/raw/<sha256>` and search for the name. Extractions are private; search them in R2 (`rr-internal-production`, `extractions/<sha256>`) only when the request names them. If the name is not there, the request does not apply to this capture: reply saying so, with the link.
4. Decide what goes: `raw` always holds the answer; `normalized` repeats it when the capture was parsed; an `extractions` object holds it when the extractor kept the name. Remove every one that contains the name.

## Mitigate

1. In GitHub, Actions, `evidence-removal`, Run workflow on `main`: enter the `sha256`, pick the `kind` (`raw`, `normalized` or `extractions`) and the `reason` (`personal_data_request`, or `legal_order` for an order). From the terminal: `gh workflow run evidence-removal.yml --ref main -f sha256=<hex> -f kind=raw -f reason=personal_data_request`. Run it once per artifact. The production deployment does the removal with the credentials it already holds; no secret leaves Vercel.
2. Read the job log. `"created": true` means it was removed now; `"created": false` means it had already been removed. A rerun is always safe: the removal is recorded only after the object is deleted and its CDN copy purged.
3. If the job fails:
   - HTTP 401: the `CRON_SECRET` secret of the `production-ops` GitHub environment differs from the one in Vercel production. Copy it again (GitHub, Settings, Environments, `production-ops`) and rerun.
   - HTTP 503: R2 or the Cloudflare purge did not answer. Rerun after a minute.
   - HTTP 500: read the function log in Vercel (Logs, path `/api/internal/evidence/remove`). A missing variable is named there; add it in Vercel production (Settings, Environment Variables), redeploy and rerun. A purge refused with 403 means the token lost the zone's Cache Purge permission; fix it in Cloudflare (My Profile, API Tokens) and rerun.

## Verify

Within 60 s `curl -sI https://ev.reranker.co/raw/<sha256>` answers 404, and the bundle shows `"status": "removed"` for that artifact. Then reply to the requester in Spanish: what was removed (the link to the answer, now 404), that the verifiable record keeps only a digest from which the text cannot be recovered, and the date.

## Record

In the claims log: the request date, who asked and in which capacity, the capture id, each digest and kind removed, the reason, the reply date and its text. `artifact_removals` keeps the date and reason of every removal and cannot be edited. Reply within the policy's deadlines: 10 business days for a query, 15 for a claim.
