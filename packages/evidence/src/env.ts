import {
  config,
  defineEnv,
  type EnvOf,
  EnvValidationError,
  forbiddenIn,
  requiredIn,
  secret,
} from "@reranker/env";
import { z } from "@reranker/schema";

const PROD = ["production"] as const;
// Previews and development seal with the preview keys and buckets, and never buy qtsa.eu stamps.
const OUTSIDE_PROD = ["preview", "development"] as const;

const kmsKeyArn = (description: string) =>
  requiredIn(
    PROD,
    config(z.string().regex(/^arn:aws:kms:[a-z0-9-]+:\d{12}:(key|alias)\/[\w/-]+$/), description),
  );
// R2 bucket names: 3 to 63 lowercase letters, digits and hyphens.
const bucket = (description: string) =>
  requiredIn(PROD, config(z.string().regex(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/), description));
const publicBaseUrl = (description: string) =>
  requiredIn(
    PROD,
    config(
      z.url({ protocol: /^https$/ }).transform((url) => url.replace(/\/+$/, "")),
      description,
    ),
  );
const hex = (length: number) => z.string().regex(new RegExp(`^[0-9a-f]{${length}}$`));

// No variable holds private key material: signing happens inside AWS KMS, reached through
// Vercel OIDC, so the deployment only knows ARNs.
export const evidenceEnv = z.object({
  AWS_REGION: requiredIn(
    PROD,
    config(z.string().regex(/^[a-z]{2}(-[a-z]+)+-\d$/), "AWS region of the evidence KMS keys"),
  ),
  AWS_ROLE_ARN: requiredIn(
    PROD,
    config(
      z.string().regex(/^arn:aws:iam::\d{12}:role\/[\w+=,.@/-]+$/),
      "IAM role this deployment assumes through Vercel OIDC to sign with KMS",
    ),
  ),
  EVIDENCE_CAPTURE_KMS_KEY_ARN: kmsKeyArn("KMS key ARN that signs capture statements"),
  EVIDENCE_LOG_KMS_KEY_ARN: kmsKeyArn("KMS key ARN that signs log checkpoints"),
  EVIDENCE_CAPTURE_KEY_ID: requiredIn(
    PROD,
    config(z.string().min(1), "keyid of the capture statement signing key"),
  ),
  EVIDENCE_LOG_KEY_ID: requiredIn(
    PROD,
    config(z.string().min(1), "Key name of the log checkpoint signing key"),
  ),
  EVIDENCE_LOG_ORIGIN: requiredIn(
    PROD,
    config(z.string().regex(/^\S+$/), "Origin line of the log checkpoints"),
  ),
  R2_ACCOUNT_ID: requiredIn(PROD, config(hex(32), "Cloudflare account id that owns the buckets")),
  R2_ACCESS_KEY_ID: requiredIn(
    PROD,
    secret(z.string().min(1), "R2 S3 access key id, scoped to this environment's buckets"),
  ),
  // R2 derives it as the SHA-256 of the API token value.
  R2_SECRET_ACCESS_KEY: requiredIn(PROD, secret(hex(64), "R2 S3 secret access key")),
  R2_EVIDENCE_BUCKET: bucket("Public evidence bucket (raw, request, normalized, plans, envelopes)"),
  R2_LOG_BUCKET: bucket("Public transparency log bucket (tiles and checkpoint)"),
  R2_INTERNAL_BUCKET: bucket("Private bucket for artifacts that are never served (extractions)"),
  EVIDENCE_ARTIFACTS_BASE_URL: publicBaseUrl("Public domain of the evidence bucket"),
  EVIDENCE_LOG_BASE_URL: publicBaseUrl("Public domain of the log bucket"),
  CLOUDFLARE_CACHE_PURGE_TOKEN: requiredIn(
    PROD,
    secret(z.string().min(1), "Cloudflare API token that purges the evidence zone's cache"),
  ),
  CLOUDFLARE_ZONE_ID: requiredIn(PROD, config(hex(32), "Cloudflare zone id of reranker.co")),
  // Optional even in production: the qtsa.eu anchor reports its own failure and the launch gate
  // checks the purchase, so sealing never waits on it.
  QTSA_TSA_URL: forbiddenIn(
    OUTSIDE_PROD,
    secret(z.url({ protocol: /^https$/ }), "qtsa.eu RFC 3161 endpoint, with its credentials"),
  ),
  QTSA_PACKAGE_SIZE: forbiddenIn(
    OUTSIDE_PROD,
    config(z.coerce.number().int().positive(), "Timestamps in the qtsa.eu package bought"),
  ),
  QTSA_PACKAGE_PURCHASED_AT: forbiddenIn(
    OUTSIDE_PROD,
    config(z.iso.date(), "Purchase date of the qtsa.eu package (YYYY-MM-DD)"),
  ),
});

export type EvidenceEnv = EnvOf<[typeof evidenceEnv]>;

let cached: EvidenceEnv | undefined;

/** The evidence variables, validated on first use so a missing one fails the sealing call, not the boot. */
export function getEvidenceEnv(): EvidenceEnv {
  cached ??= defineEnv([evidenceEnv]);
  return cached;
}

/**
 * The listed variables, which outside production may be unset: an operation that needs one fails
 * closed, naming every missing variable, before it calls anything.
 */
export function requireEvidenceEnv<const K extends keyof EvidenceEnv>(
  ...names: K[]
): { [P in K]-?: NonNullable<EvidenceEnv[P]> } {
  const env = getEvidenceEnv();
  const missing = names.filter((name) => env[name] === undefined);
  if (missing.length > 0) {
    throw new EnvValidationError(missing.map((name) => ({ name, problem: "missing" })));
  }
  return Object.fromEntries(names.map((name) => [name, env[name]])) as {
    [P in K]-?: NonNullable<EvidenceEnv[P]>;
  };
}

/** Drops the memoized environment so a test can change it. */
export function resetEvidenceEnv(): void {
  cached = undefined;
}
