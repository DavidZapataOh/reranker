import { server } from "@reranker/testing/msw";
import type { TrustedKey } from "@reranker/verify/trust";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

const key = (purpose: "capture" | "log", byte: number): TrustedKey => ({
  keyid: `rr-${purpose}-test`,
  purpose,
  env: "production",
  alg: "Ed25519",
  publicKey: Buffer.alloc(32, byte).toString("base64"),
  custody: "aws-kms-hsm",
  validFrom: "2026-11-20T00:00:00Z",
  validTo: null,
  compromisedAfter: null,
});
const pinned = vi.hoisted((): TrustedKey[] => []);
vi.mock("@reranker/verify/trust", () => ({ TRUSTED_KEYS: pinned }));
pinned.push(key("capture", 1), key("log", 2));

const { checkEvidenceAuditTrail, checkEvidenceSigningKey, checkQtsaBalance } = await import(
  "./evidence"
);

const ENV_API = "https://api.vercel.com/v10/projects/prj_8FGjUOaSl4kY2Fc26r7vbuVhivql/env";
const CAPTURE_ARN = "arn:aws:kms:us-east-1:123456789012:key/capture";
const LOG_ARN = "arn:aws:kms:us-east-1:123456789012:key/log";
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const spki = (byte: number) => Buffer.concat([SPKI_PREFIX, Buffer.alloc(32, byte)]);
const vercelEnv = (names: string[]) =>
  server.use(http.get(ENV_API, () => HttpResponse.json({ envs: names.map((key) => ({ key })) })));

beforeAll(() => server.listen());
beforeEach(() => {
  vi.stubEnv("APP_ENV", "production");
  vi.stubEnv("AWS_REGION", "us-east-1");
  vi.stubEnv("AWS_ROLE_ARN", "arn:aws:iam::123456789012:role/reranker-evidence-production");
  vi.stubEnv("EVIDENCE_CAPTURE_KMS_KEY_ARN", CAPTURE_ARN);
  vi.stubEnv("EVIDENCE_LOG_KMS_KEY_ARN", LOG_ARN);
  vi.stubEnv("VERCEL_BILLING_READ_TOKEN", "vercel-token");
});
afterEach(() => {
  server.resetHandlers();
  vi.unstubAllEnvs();
});
afterAll(() => server.close());

describe("evidence-signing-key", () => {
  const kms = (keys: Record<string, Buffer>) => ({
    send: vi.fn(async (command: { input: { KeyId: string } }) => ({
      PublicKey: keys[command.input.KeyId],
    })),
  });

  test("passes when both KMS keys hold the pinned public keys and Vercel holds no private key", async () => {
    vercelEnv(["AWS_ROLE_ARN", "EVIDENCE_CAPTURE_KMS_KEY_ARN"]);
    const client = kms({ [CAPTURE_ARN]: spki(1), [LOG_ARN]: spki(2) });
    await expect(checkEvidenceSigningKey(undefined, client as never)).resolves.toMatchObject({
      status: "pass",
    });
    expect(client.send).toHaveBeenCalledTimes(2);
  });

  test("fails when a KMS key differs from the registry or Vercel holds a private key", async () => {
    vercelEnv(["EVIDENCE_SIGNING_KEY", "AWS_ROLE_ARN"]);
    const client = kms({ [CAPTURE_ARN]: spki(1), [LOG_ARN]: spki(9) });
    const result = await checkEvidenceSigningKey(undefined, client as never);
    expect(result.status).toBe("fail");
    expect(result.reason).toContain("la clave de KMS de log no es rr-log-test");
    expect(result.reason).toContain("EVIDENCE_SIGNING_KEY");
  });

  test("is unknown, not failed, while AWS is not configured", async () => {
    vi.stubEnv("AWS_ROLE_ARN", "");
    await expect(checkEvidenceSigningKey()).resolves.toMatchObject({ status: "unknown" });
  });
});

describe("evidence-audit-trail", () => {
  const now = new Date("2026-11-20T12:00:00Z");
  const clients = (status: object, files: number) => ({
    cloudtrail: { send: vi.fn(async () => status) },
    s3: { send: vi.fn(async (_command: unknown) => ({ KeyCount: files })) },
  });
  const healthy = { IsLogging: true, LatestDeliveryTime: new Date("2026-11-20T11:30:00Z") };

  test("passes when the trail logs, delivers and today's files reached the bucket", async () => {
    const c = clients(healthy, 1);
    await expect(checkEvidenceAuditTrail(undefined, c as never, now)).resolves.toMatchObject({
      status: "pass",
    });
    const listed = c.s3.send.mock.calls[0]?.[0] as { input: object };
    expect(listed.input).toEqual({
      Bucket: "rr-cloudtrail-123456789012",
      Prefix: "AWSLogs/123456789012/CloudTrail/us-east-1/2026/11/20/",
      MaxKeys: 1,
    });
  });

  test("fails when the trail stopped, has a delivery error or nothing reached S3 in 24 h", async () => {
    const stopped = { IsLogging: false, LatestDeliveryError: "AccessDenied" };
    const result = await checkEvidenceAuditTrail(undefined, clients(stopped, 0) as never, now);
    expect(result.status).toBe("fail");
    expect(result.reason).toContain("no está registrando");
    expect(result.reason).toContain("AccessDenied");
    expect(result.reason).toContain("sin entregas en 2 h");
    expect(result.reason).toContain("24 h");
  });
});

describe("qtsa-balance", () => {
  const now = new Date("2026-12-01T00:00:00Z");

  test("is pending, not failed, until the package is bought", async () => {
    const used = vi.fn();
    await expect(checkQtsaBalance(now, used)).resolves.toEqual({
      id: "qtsa-balance",
      status: "unknown",
      reason: "pendiente: el paquete de qtsa.eu aún no se compra",
    });
    expect(used).not.toHaveBeenCalled();
  });

  test("passes with more than two months of stamps and fails below that or near expiry", async () => {
    vi.stubEnv("QTSA_PACKAGE_SIZE", "12000");
    vi.stubEnv("QTSA_PACKAGE_PURCHASED_AT", "2026-11-25");
    const pace = (total: number, lastMonth: number) => async () => ({ total, lastMonth });
    await expect(checkQtsaBalance(now, pace(200, 720))).resolves.toMatchObject({ status: "pass" });
    await expect(checkQtsaBalance(now, pace(10_700, 720))).resolves.toMatchObject({
      status: "fail",
    });
    const late = new Date("2028-10-01T00:00:00Z");
    const expiring = await checkQtsaBalance(late, pace(200, 10));
    expect(expiring).toMatchObject({ status: "fail" });
    expect(expiring.reason).toContain("vence el 2028-11-25");
  });
});
