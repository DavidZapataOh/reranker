import { CloudTrailClient, GetTrailStatusCommand } from "@aws-sdk/client-cloudtrail";
import { GetPublicKeyCommand, KMSClient } from "@aws-sdk/client-kms";
import { ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { withSystem } from "@reranker/db";
import { timestampAnchors } from "@reranker/db/schema";
import { defineEnv } from "@reranker/env";
import { TRUSTED_KEYS } from "@reranker/verify/trust";
import { awsCredentialsProvider } from "@vercel/oidc-aws-credentials-provider";
import { and, count, eq, gte, ne } from "drizzle-orm";
import { launchEnv } from "../env";
import { type CheckResult, verdict } from "./types";

const env = launchEnv.pick({
  AWS_REGION: true,
  AWS_ROLE_ARN: true,
  EVIDENCE_CAPTURE_KMS_KEY_ARN: true,
  EVIDENCE_LOG_KMS_KEY_ARN: true,
  VERCEL_BILLING_READ_TOKEN: true,
  QTSA_PACKAGE_SIZE: true,
  QTSA_PACKAGE_PURCHASED_AT: true,
});

const TRAIL = "reranker-audit";
const PROJECT_ENV = "https://api.vercel.com/v10/projects/prj_8FGjUOaSl4kY2Fc26r7vbuVhivql/env";
// A signing key has no business in a variable: the private half never leaves KMS.
const PRIVATE_KEY_NAME = /SIGNING_KEY|PRIVATE_KEY|_SK(_|$)/;
const DELIVERY_MAX_AGE_MS = 2 * 3_600_000;
const DAY_MS = 86_400_000;
const MONTH_MS = 30 * DAY_MS;
const QTSA_VALIDITY_MONTHS = 24;
const MARGIN_MONTHS = 2;
const ED25519_PUBLIC_KEY_BYTES = 32;

type Aws = { region: string; roleArn: string; account: string };

function aws(): Aws | string {
  const { AWS_REGION: region, AWS_ROLE_ARN: roleArn } = defineEnv([env]);
  if (!region || !roleArn) return "faltan AWS_REGION o AWS_ROLE_ARN";
  const account = /^arn:aws:iam::(\d{12}):role\//.exec(roleArn)?.[1];
  return account ? { region, roleArn, account } : "AWS_ROLE_ARN no es la ARN de un rol";
}

const credentials = (a: Aws) => awsCredentialsProvider({ roleArn: a.roleArn });

/**
 * Both KMS keys hold the public keys pinned in @reranker/verify, and no Vercel variable carries
 * what looks like private key material.
 */
export async function checkEvidenceSigningKey(
  signal?: AbortSignal,
  kms?: Pick<KMSClient, "send">,
): Promise<CheckResult> {
  const id = "evidence-signing-key";
  const a = aws();
  if (typeof a === "string") return { id, status: "unknown", reason: a };
  const e = defineEnv([env]);
  const client = kms ?? new KMSClient({ region: a.region, credentials: credentials(a) });
  const problems: string[] = [];
  for (const [purpose, arn] of [
    ["capture", e.EVIDENCE_CAPTURE_KMS_KEY_ARN],
    ["log", e.EVIDENCE_LOG_KMS_KEY_ARN],
  ] as const) {
    const pinned = TRUSTED_KEYS.find(
      (k) => k.purpose === purpose && k.validTo === null && k.compromisedAfter === null,
    );
    if (!pinned || !arn) {
      problems.push(`sin clave de ${purpose} fijada o sin su ARN`);
      continue;
    }
    const { PublicKey } = await client.send(new GetPublicKeyCommand({ KeyId: arn }), {
      ...(signal && { abortSignal: signal }),
    });
    const raw = PublicKey && Buffer.from(PublicKey).subarray(-ED25519_PUBLIC_KEY_BYTES);
    if (!raw?.equals(Buffer.from(pinned.publicKey, "base64"))) {
      problems.push(`la clave de KMS de ${purpose} no es ${pinned.keyid}`);
    }
  }
  const token = e.VERCEL_BILLING_READ_TOKEN;
  if (!token) return { id, status: "unknown", reason: "falta VERCEL_BILLING_READ_TOKEN" };
  const response = await fetch(`${PROJECT_ENV}?teamId=team_Z821WJ1qhLyT3ohz19uC3MOm`, {
    headers: { Authorization: `Bearer ${token}` },
    ...(signal && { signal }),
  });
  if (!response.ok) return { id, status: "unknown", reason: `Vercel respondió ${response.status}` };
  const { envs } = (await response.json()) as { envs: { key: string }[] };
  for (const name of new Set(envs.map((v) => v.key).filter((k) => PRIVATE_KEY_NAME.test(k)))) {
    problems.push(`Vercel tiene la variable ${name}`);
  }
  return verdict(
    id,
    problems,
    "las claves de KMS coinciden con el registro y no hay claves privadas en Vercel",
  );
}

const dayPrefix = (account: string, region: string, at: Date) =>
  `AWSLogs/${account}/CloudTrail/${region}/${at.toISOString().slice(0, 10).replaceAll("-", "/")}/`;

/** The trail logs, delivers without errors, and today's or yesterday's log files reached S3. */
export async function checkEvidenceAuditTrail(
  signal?: AbortSignal,
  clients?: { cloudtrail: Pick<CloudTrailClient, "send">; s3: Pick<S3Client, "send"> },
  now = new Date(),
): Promise<CheckResult> {
  const id = "evidence-audit-trail";
  const a = aws();
  if (typeof a === "string") return { id, status: "unknown", reason: a };
  const config = { region: a.region, credentials: credentials(a) };
  const { cloudtrail, s3 } = clients ?? {
    cloudtrail: new CloudTrailClient(config),
    s3: new S3Client(config),
  };
  const options = signal ? { abortSignal: signal } : {};
  const status = await cloudtrail.send(new GetTrailStatusCommand({ Name: TRAIL }), options);
  const problems: string[] = [];
  if (!status.IsLogging) problems.push(`${TRAIL} no está registrando`);
  if (status.LatestDeliveryError) problems.push(`error de entrega: ${status.LatestDeliveryError}`);
  const delivered = status.LatestDeliveryTime?.getTime() ?? 0;
  if (now.getTime() - delivered > DELIVERY_MAX_AGE_MS) problems.push("sin entregas en 2 h");
  // Signing records are management events, so any file of the last day carries them.
  let files = 0;
  for (const day of [now, new Date(now.getTime() - DAY_MS)]) {
    const listed = await s3.send(
      new ListObjectsV2Command({
        Bucket: `rr-cloudtrail-${a.account}`,
        Prefix: dayPrefix(a.account, a.region, day),
        MaxKeys: 1,
      }),
      options,
    );
    files += listed.KeyCount ?? 0;
  }
  if (files === 0) problems.push("el bucket no recibió registros en 24 h");
  return verdict(id, problems, `${TRAIL} registra y entrega al bucket`);
}

/**
 * Enough qtsa.eu stamps for two more months at the last 30 days' pace, and the package does not
 * expire within two months. Until the package is bought the check is pending, not failed.
 */
export async function checkQtsaBalance(
  now = new Date(),
  used = qtsaStampsUsed,
): Promise<CheckResult> {
  const id = "qtsa-balance";
  const { QTSA_PACKAGE_SIZE: size, QTSA_PACKAGE_PURCHASED_AT: purchasedAt } = defineEnv([env]);
  if (!size || !purchasedAt) {
    return { id, status: "unknown", reason: "pendiente: el paquete de qtsa.eu aún no se compra" };
  }
  const purchase = new Date(`${purchasedAt}T00:00:00Z`);
  const { total, lastMonth } = await used(purchase, new Date(now.getTime() - MONTH_MS));
  const problems: string[] = [];
  const left = size - total;
  if (left < lastMonth * MARGIN_MONTHS)
    problems.push(`quedan ${left} sellos, menos de 2 meses de uso`);
  const expires = new Date(purchase);
  expires.setUTCMonth(expires.getUTCMonth() + QTSA_VALIDITY_MONTHS);
  if (expires.getTime() - now.getTime() < MARGIN_MONTHS * MONTH_MS) {
    problems.push(`el paquete vence el ${expires.toISOString().slice(0, 10)}`);
  }
  return verdict(id, problems, `quedan ${left} sellos de ${size}`);
}

async function qtsaStampsUsed(since: Date, monthAgo: Date) {
  const stamped = (from: Date) =>
    and(
      eq(timestampAnchors.provider, "qtsa"),
      ne(timestampAnchors.status, "failed"),
      gte(timestampAnchors.createdAt, from),
    );
  return withSystem("launch.qtsa_balance", async (tx) => {
    const [all] = await tx.select({ n: count() }).from(timestampAnchors).where(stamped(since));
    const [recent] = await tx
      .select({ n: count() })
      .from(timestampAnchors)
      .where(stamped(monthAgo));
    return { total: all?.n ?? 0, lastMonth: recent?.n ?? 0 };
  });
}
