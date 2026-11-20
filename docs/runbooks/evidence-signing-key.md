# Evidence signing keys

## Trigger

Setting up or changing the keys that sign evidence: a new yearly key (the 2027 log needs its own before 1 January), a suspected compromise, `launch:check` reporting `evidence-signing-key` as failed, or a change to who may sign.

## Impact

Statements are signed with `rr-capture-2026-1-ed25519` and checkpoints with `rr-log-2026-1`, both Ed25519 keys inside AWS KMS (account in `vars.AWS_ACCOUNT_ID`, `us-east-1`). Production deployments of the `reranker` project assume `reranker-evidence-production` through Vercel OIDC; previews and development assume `reranker-evidence-preview` and sign with `rr-capture-preview-2026-1-ed25519` and `rr-log-preview-2026-1`. Each key policy grants `kms:Sign` to those roles only and denies it to every other principal, so a preview can never sign production evidence. If signing fails, sealing fails closed: no capture is stored without its envelope.

Log keys sign under the log's origin as the signed-note key name. Production has one origin, `log.reranker.co/captures/2026`, published as a verifier key at `/.well-known/reranker-log-keys`. Each preview deployment logs under its own origin (`log-preview.reranker.co/pr-<n>/<branch>/captures/2026`) and all of them share the preview log key; a verifier derives the key ID from the origin it checks and the pinned public key.

## Diagnose

1. The daily digest email lists `evidence-signing-key`, which names the key that differs or the Vercel variable that looks like private key material. Only a production deployment can run it: `vercel env pull` always hands out a development OIDC token, which the production role refuses, so a local `pnpm launch:check` reports this item and `evidence-audit-trail` as `unknown (AccessDenied)`.
2. The three public copies agree: `curl -s https://reranker.co/.well-known/jwks.json`, `dig +short TXT _rr-keys.reranker.co @1.1.1.1` and `KEYS_BY_ENV` in `packages/verify/src/trust/keys.ts`.
3. Who signed: the `reranker-audit` trail delivers every `kms:Sign` to `rr-cloudtrail-<account>` and keeps it seven years (`launch:check` item `evidence-audit-trail`).

## Mitigate

1. Ask the founder for a temporary IAM user with `AdministratorAccess` and its access key in the GitHub secrets `AWS_SETUP_ACCESS_KEY_ID` and `AWS_SETUP_SECRET_ACCESS_KEY`. Nothing in AWS is administered without it.
2. Change the declared state in `packages/evidence/scripts/aws-state.ts` (a new key is a new entry in `KEYS`) through a pull request.
3. In GitHub, Actions, `aws`, run on `main` with `dry-run` checked; read the changes it would make. Then run it unchecked. The job summary lists every role and key ARN and the registry entries.
4. Pin the new entries in `KEYS_BY_ENV`, mirror the production ones in `KEY_RECORDS` of `apps/web/scripts/provision-dns.ts`, and set the key ARNs in Vercel (`EVIDENCE_CAPTURE_KMS_KEY_ARN`, `EVIDENCE_LOG_KMS_KEY_ARN`, and `AWS_ROLE_ARN` if the role changed) for each environment. For a compromised key set `compromisedAfter` instead of removing it, so earlier signatures keep verifying.
5. After the merge, run the `dns` workflow on `main` to publish the TXT record.
6. Delete the setup user and the two GitHub secrets with the `aws` workflow's cleanup step.

## Verify

`launch:check` shows `evidence-signing-key` and `evidence-audit-trail` as `pass`; the JWKS and the TXT record list exactly the production keys within an hour (the JWKS caches for one hour, the TXT record for its TTL); a new capture's bundle verifies with `@reranker/verify`.

## Record

The date, the keyids and ARNs added or retired, and the run IDs of the `aws` and `dns` workflows, in the pull request that changed `aws-state.ts`.
