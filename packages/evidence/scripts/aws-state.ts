// Declared state of the AWS infrastructure that signs evidence: who may assume which role, which
// role may sign with which KMS key, and where the signing records are kept.
import type { LifecycleRule } from "@aws-sdk/client-s3";

// The functions that sign run in Vercel's iad1, which is us-east-1.
export const REGION = "us-east-1";
const TEAM = "davidzapataohs-projects";
const PROJECT = "reranker";
const REPO = "DavidZapataOh/reranker";
export const TRAIL = "reranker-audit";

// https://vercel.com/docs/oidc/aws with the project's issuer mode set to Team.
export const ISSUERS = {
  vercel: { host: `oidc.vercel.com/${TEAM}`, audience: `https://vercel.com/${TEAM}` },
  github: { host: "token.actions.githubusercontent.com", audience: "sts.amazonaws.com" },
} as const;

const vercelSubject = (env: string) => `owner:${TEAM}:project:${PROJECT}:environment:${env}`;

type Env = "production" | "preview";
type Purpose = "capture" | "log";

export interface KeySpec {
  alias: string;
  env: Env;
  purpose: Purpose;
  keyid: string;
}

export const KEYS: readonly KeySpec[] = [
  {
    alias: "alias/rr-capture-2026",
    env: "production",
    purpose: "capture",
    keyid: "rr-capture-2026-1-ed25519",
  },
  { alias: "alias/rr-log-2026", env: "production", purpose: "log", keyid: "rr-log-2026-1" },
  {
    alias: "alias/rr-capture-2026-preview",
    env: "preview",
    purpose: "capture",
    keyid: "rr-capture-preview-2026-1-ed25519",
  },
  {
    alias: "alias/rr-log-2026-preview",
    env: "preview",
    purpose: "log",
    keyid: "rr-log-preview-2026-1",
  },
];

export interface RoleSpec {
  name: string;
  description: string;
  issuer: keyof typeof ISSUERS;
  /** Exact `sub` claims allowed to assume the role; any one of them. */
  subjects: readonly string[];
  env: Env;
  signs: readonly Purpose[];
  readsAuditTrail?: boolean;
}

export const ROLES: readonly RoleSpec[] = [
  {
    name: "reranker-evidence-production",
    description: "Production deployments of reranker sign evidence with the production KMS keys",
    issuer: "vercel",
    subjects: [vercelSubject("production")],
    env: "production",
    signs: ["capture", "log"],
    readsAuditTrail: true,
  },
  {
    name: "reranker-evidence-preview",
    description: "Preview and development deployments of reranker sign with the preview KMS keys",
    issuer: "vercel",
    subjects: [vercelSubject("preview"), vercelSubject("development")],
    env: "preview",
    signs: ["capture", "log"],
  },
  {
    name: "reranker-ci-kms-preview",
    description: "The nightly KMS contract test on main signs with the preview capture key",
    issuer: "github",
    subjects: [`repo:${REPO}:ref:refs/heads/main`],
    env: "preview",
    signs: ["capture"],
  },
];

export const ROLE_POLICY = "evidence-kms";
const SIGN_CONDITION = {
  StringEquals: { "kms:SigningAlgorithm": "ED25519_SHA_512", "kms:MessageType": "RAW" },
};
// The console's key administrators statement: everything but cryptographic use.
const KEY_ADMIN_ACTIONS = [
  "kms:Create*",
  "kms:Describe*",
  "kms:Enable*",
  "kms:List*",
  "kms:Put*",
  "kms:Update*",
  "kms:Revoke*",
  "kms:Disable*",
  "kms:Get*",
  "kms:Delete*",
  "kms:TagResource",
  "kms:UntagResource",
  "kms:ScheduleKeyDeletion",
  "kms:CancelKeyDeletion",
  "kms:RotateKeyOnDemand",
];
export const TAGS = [{ Key: "app", Value: "reranker" }];

export const roleArn = (account: string, name: string) => `arn:aws:iam::${account}:role/${name}`;
export const bucketName = (account: string) => `rr-cloudtrail-${account}`;
export const trailArn = (account: string) =>
  `arn:aws:cloudtrail:${REGION}:${account}:trail/${TRAIL}`;
export const providerArn = (account: string, host: string) =>
  `arn:aws:iam::${account}:oidc-provider/${host}`;
const one = <T>(values: readonly T[]): T | readonly T[] =>
  values.length === 1 && values[0] !== undefined ? values[0] : values;

export function trustPolicy(account: string, role: RoleSpec) {
  const { host, audience } = ISSUERS[role.issuer];
  return {
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Principal: { Federated: providerArn(account, host) },
        Action: "sts:AssumeRoleWithWebIdentity",
        Condition: {
          StringEquals: { [`${host}:aud`]: audience, [`${host}:sub`]: one(role.subjects) },
        },
      },
    ],
  };
}

/**
 * Signing is granted to the roles of the key's environment by name and denied to every other
 * principal, so neither an IAM policy nor a grant can let a preview deployment sign production
 * evidence. The account keeps administration, which never includes signing.
 */
export function keyPolicy(account: string, key: KeySpec) {
  const ofEnv = ROLES.filter((r) => r.env === key.env);
  const signers = ofEnv
    .filter((r) => r.signs.includes(key.purpose))
    .map((r) => roleArn(account, r.name));
  return {
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "KeyAdministration",
        Effect: "Allow",
        Principal: { AWS: `arn:aws:iam::${account}:root` },
        Action: KEY_ADMIN_ACTIONS,
        Resource: "*",
      },
      {
        Sid: "ReadPublicKey",
        Effect: "Allow",
        Principal: { AWS: one(ofEnv.map((r) => roleArn(account, r.name))) },
        Action: "kms:GetPublicKey",
        Resource: "*",
      },
      {
        Sid: "SignEvidence",
        Effect: "Allow",
        Principal: { AWS: one(signers) },
        Action: "kms:Sign",
        Resource: "*",
        Condition: SIGN_CONDITION,
      },
      {
        Sid: "DenySigningToEveryoneElse",
        Effect: "Deny",
        Principal: { AWS: "*" },
        Action: "kms:Sign",
        Resource: "*",
        Condition: { ArnNotEquals: { "aws:PrincipalArn": one(signers) } },
      },
    ],
  };
}

export function rolePolicy(account: string, role: RoleSpec, keyArns: ReadonlyMap<string, string>) {
  const arns = (keys: readonly KeySpec[]) => keys.map((k) => keyArns.get(k.alias) ?? k.alias);
  const ofEnv = KEYS.filter((k) => k.env === role.env);
  return {
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "SignEvidence",
        Effect: "Allow",
        Action: "kms:Sign",
        Resource: one(arns(ofEnv.filter((k) => role.signs.includes(k.purpose)))),
        Condition: SIGN_CONDITION,
      },
      { Sid: "ReadPublicKeys", Effect: "Allow", Action: "kms:GetPublicKey", Resource: arns(ofEnv) },
      ...(role.readsAuditTrail
        ? [
            {
              Sid: "ReadTrailStatus",
              Effect: "Allow",
              Action: "cloudtrail:GetTrailStatus",
              Resource: trailArn(account),
            },
            {
              Sid: "ListAuditLogs",
              Effect: "Allow",
              Action: "s3:ListBucket",
              Resource: `arn:aws:s3:::${bucketName(account)}`,
            },
          ]
        : []),
    ],
  };
}

/** CloudTrail's documented bucket policy, scoped to this trail, plus TLS-only access. */
export function bucketPolicy(account: string) {
  const bucket = `arn:aws:s3:::${bucketName(account)}`;
  const source = { "aws:SourceArn": trailArn(account) };
  return {
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "AWSCloudTrailAclCheck20150319",
        Effect: "Allow",
        Principal: { Service: "cloudtrail.amazonaws.com" },
        Action: "s3:GetBucketAcl",
        Resource: bucket,
        Condition: { StringEquals: source },
      },
      {
        Sid: "AWSCloudTrailWrite20150319",
        Effect: "Allow",
        Principal: { Service: "cloudtrail.amazonaws.com" },
        Action: "s3:PutObject",
        Resource: `${bucket}/AWSLogs/${account}/*`,
        Condition: { StringEquals: { "s3:x-amz-acl": "bucket-owner-full-control", ...source } },
      },
      {
        Sid: "DenyInsecureTransport",
        Effect: "Deny",
        Principal: "*",
        Action: "s3:*",
        Resource: [bucket, `${bucket}/*`],
        Condition: { Bool: { "aws:SecureTransport": "false" } },
      },
    ],
  };
}

// The console keeps 90 days of events; the bucket keeps signing records for seven years.
export const LIFECYCLE: LifecycleRule[] = [
  {
    ID: "archive-then-expire",
    Status: "Enabled",
    Filter: { Prefix: "" },
    Transitions: [{ Days: 90, StorageClass: "GLACIER_IR" }],
    Expiration: { Days: 2557 },
  },
];

export const PUBLIC_ACCESS_BLOCK = {
  BlockPublicAcls: true,
  IgnorePublicAcls: true,
  BlockPublicPolicy: true,
  RestrictPublicBuckets: true,
};

/** Compares policies as AWS returns them: key order and one-element arrays do not count. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) {
    const items = value.map(canonical);
    return items.length === 1 ? items[0] : items.map((i) => JSON.stringify(i)).sort();
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonical(v)]),
    );
  }
  return value;
}
export const samePolicy = (actual: string | undefined, wanted: unknown) =>
  actual !== undefined &&
  JSON.stringify(canonical(JSON.parse(decodeURIComponent(actual)))) ===
    JSON.stringify(canonical(wanted));
