const account = "0123456789abcdef0123456789abcdef";
const kmsKey = (name: string) => `arn:aws:kms:us-east-1:111122223333:key/${name}`;

/** A complete preview environment with well-formed, non-working values. */
export const previewEnv = {
  APP_ENV: "preview",
  AWS_REGION: "us-east-1",
  AWS_ROLE_ARN: "arn:aws:iam::111122223333:role/reranker-evidence-preview",
  EVIDENCE_CAPTURE_KMS_KEY_ARN: kmsKey("1234abcd-12ab-34cd-56ef-1234567890ab"),
  EVIDENCE_LOG_KMS_KEY_ARN: kmsKey("5678abcd-12ab-34cd-56ef-1234567890ab"),
  EVIDENCE_CAPTURE_KEY_ID: "rr-capture-preview-1-ed25519",
  EVIDENCE_LOG_KEY_ID: "rr-log-preview-1",
  EVIDENCE_LOG_ORIGIN: "log-preview.reranker.co/captures/2026",
  R2_ACCOUNT_ID: account,
  R2_ACCESS_KEY_ID: "fedcba9876543210fedcba9876543210",
  R2_SECRET_ACCESS_KEY: "ab".repeat(32),
  R2_EVIDENCE_BUCKET: "rr-evidence-preview",
  R2_LOG_BUCKET: "rr-log-preview",
  R2_INTERNAL_BUCKET: "rr-internal-preview",
  EVIDENCE_ARTIFACTS_BASE_URL: "https://ev-preview.reranker.co",
  EVIDENCE_LOG_BASE_URL: "https://log-preview.reranker.co",
  CLOUDFLARE_CACHE_PURGE_TOKEN: "purge-token",
  CLOUDFLARE_ZONE_ID: "fedcba9876543210fedcba9876543210",
} as const;

export const productionEnv = {
  ...previewEnv,
  APP_ENV: "production",
  AWS_ROLE_ARN: "arn:aws:iam::111122223333:role/reranker-evidence-production",
  EVIDENCE_CAPTURE_KEY_ID: "rr-capture-2026-1-ed25519",
  EVIDENCE_LOG_KEY_ID: "rr-log-2026-1",
  EVIDENCE_LOG_ORIGIN: "log.reranker.co/captures/2026",
  R2_EVIDENCE_BUCKET: "rr-evidence-production",
  R2_LOG_BUCKET: "rr-log-production",
  R2_INTERNAL_BUCKET: "rr-internal-production",
  EVIDENCE_ARTIFACTS_BASE_URL: "https://ev.reranker.co",
  EVIDENCE_LOG_BASE_URL: "https://log.reranker.co",
  QTSA_TSA_URL: "https://tsa.qtsa.eu/example",
  QTSA_PACKAGE_SIZE: "12000",
  QTSA_PACKAGE_PURCHASED_AT: "2026-11-20",
} as const;
