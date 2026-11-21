import { createHash } from "node:crypto";
import { EnvValidationError } from "@reranker/env";
import {
  CaptureStatementV1Schema,
  KeyAnnouncementStatementV1Schema,
  ModelRegimeStatementV1Schema,
  PREDICATE,
} from "@reranker/verify/format";
import { KEYS_BY_ENV } from "@reranker/verify/trust";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  buildCaptureStatement,
  buildKeyAnnouncementStatement,
  buildModelRegimeStatement,
  buildNormalizationStatement,
  buildPlanStatement,
  workerIdentity,
} from "../src/statement";
import { predicateInput } from "./support/capture-input";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const sha = (c: string) => c.repeat(64);
const SIGNED_AT = new Date("2026-11-18T15:04:05.123Z");

beforeEach(() => {
  vi.stubEnv("VERCEL_REGION", "iad1");
  vi.stubEnv("VERCEL_GIT_COMMIT_SHA", COMMIT);
});

afterEach(() => vi.unstubAllEnvs());

describe("workerIdentity", () => {
  test("names the Vercel region and the git commit of the deployment", () => {
    expect(workerIdentity()).toEqual({ id: "vercel:iad1", image_digest: `git:${COMMIT}` });
  });

  test("fails closed, naming each variable, when the deployment is not identified", () => {
    vi.stubEnv("VERCEL_REGION", "");
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "");
    expect(workerIdentity).toThrow(EnvValidationError);
    expect(workerIdentity).toThrow("VERCEL_REGION (missing), VERCEL_GIT_COMMIT_SHA (missing)");
  });

  test("rejects a commit that is not a full git SHA", () => {
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "abc1234");
    expect(workerIdentity).toThrow("VERCEL_GIT_COMMIT_SHA (invalid)");
  });
});

describe("buildCaptureStatement", () => {
  const build = (normalizedSha256: string | null) =>
    buildCaptureStatement({
      captureId: "cap_01JBX8Q2M4ZK7P6Y3V9W1T0S5R",
      rawSha256: sha("a"),
      requestSha256: sha("b"),
      normalizedSha256,
      predicate: predicateInput,
      signedAt: SIGNED_AT,
    });

  test("is a valid capture statement v1 with its id, time and worker", () => {
    const statement = build(sha("e"));
    expect(CaptureStatementV1Schema.safeParse(statement).success).toBe(true);
    expect(statement.subject).toEqual([
      { name: "raw", digest: { sha256: sha("a") } },
      { name: "request", digest: { sha256: sha("b") } },
      { name: "normalized", digest: { sha256: sha("e") } },
    ]);
    expect(statement.predicate).toMatchObject({
      capture_id: "cap_01JBX8Q2M4ZK7P6Y3V9W1T0S5R",
      time: { worker_utc: "2026-11-18T15:04:05.123Z", roughtime: null, not_before: null },
      worker: { id: "vercel:iad1", image_digest: `git:${COMMIT}` },
    });
  });

  test("omits the normalized subject when the answer did not parse", () => {
    const statement = build(null);
    expect(statement.subject.map((s) => s.name)).toEqual(["raw", "request"]);
    expect(CaptureStatementV1Schema.safeParse(statement).success).toBe(true);
  });
});

test("a plan statement names the plan artifact and the measurement", () => {
  const statement = buildPlanStatement({
    measurementId: "0194f0c6-8d2e-7c3a-9f1b-2a4c6e8d0f12",
    planSha256: sha("f"),
    signedAt: SIGNED_AT,
  });
  expect(statement.predicateType).toBe(PREDICATE.plan);
  expect(statement.subject).toEqual([{ name: "plan", digest: { sha256: sha("f") } }]);
  expect(statement.predicate).toEqual({
    measurement_id: "0194f0c6-8d2e-7c3a-9f1b-2a4c6e8d0f12",
    time: { worker_utc: SIGNED_AT.toISOString() },
    worker: { id: "vercel:iad1", image_digest: `git:${COMMIT}` },
  });
});

test("a normalization statement keeps the raw digest and points to the capture envelope", () => {
  const statement = buildNormalizationStatement({
    captureId: "cap_01JBX8Q2M4ZK7P6Y3V9W1T0S5R",
    captureEnvelopeSha256: sha("9"),
    rawSha256: sha("a"),
    normalizedSha256: sha("8"),
    parserVersion: 2,
    signedAt: SIGNED_AT,
  });
  expect(statement.predicateType).toBe(PREDICATE.normalization);
  expect(statement.subject).toEqual([
    { name: "raw", digest: { sha256: sha("a") } },
    { name: "normalized", digest: { sha256: sha("8") } },
  ]);
  expect(statement.predicate).toMatchObject({
    capture_id: "cap_01JBX8Q2M4ZK7P6Y3V9W1T0S5R",
    capture_envelope: { digest: { sha256: sha("9") } },
    parser_version: 2,
  });
});

test("a key announcement names the raw public key by keyid and states the pinned entry", () => {
  const [capture, log] = KEYS_BY_ENV.production;
  if (!capture || !log) throw new Error("the production keys are pinned");
  const statement = buildKeyAnnouncementStatement({
    key: capture,
    previous: log,
    signedAt: SIGNED_AT,
  });
  expect(KeyAnnouncementStatementV1Schema.safeParse(statement).success).toBe(true);
  expect(statement.subject).toEqual([
    {
      name: capture.keyid,
      digest: {
        sha256: createHash("sha256").update(Buffer.from(capture.publicKey, "base64")).digest("hex"),
      },
    },
  ]);
  expect(statement.predicate).toEqual({
    key: {
      keyid: capture.keyid,
      purpose: "capture",
      env: "production",
      alg: "Ed25519",
      public_key: capture.publicKey,
      custody: "aws-kms-hsm",
      valid_from: capture.validFrom,
    },
    previous: { keyid: log.keyid },
    time: { worker_utc: SIGNED_AT.toISOString() },
    worker: { id: "vercel:iad1", image_digest: `git:${COMMIT}` },
  });
  expect(
    buildKeyAnnouncementStatement({ key: log, previous: null, signedAt: SIGNED_AT }).predicate
      .previous,
  ).toBeNull();
});

test("a model regime names the first capture's envelope and the change it records", () => {
  const regime = {
    regime_id: "0193b6f2-7c1e-7a51-9b3a-5f2e8d4c1a90",
    engine: "chatgpt",
    channel: "api",
    vendor: "openai",
    from: "gpt-6.1-terra-2026-10-01",
    to: "gpt-6.1-terra-2026-11-15",
    first_capture_id: "cap_01JBX8Q2M4ZK7P6Y3V9W1T0S5R" as const,
    opened_at: "2026-11-20T10:05:00.000Z",
  };
  const statement = buildModelRegimeStatement({
    regime,
    firstCaptureEnvelopeSha256: sha("c"),
    signedAt: SIGNED_AT,
  });
  expect(ModelRegimeStatementV1Schema.safeParse(statement).success).toBe(true);
  expect(statement.predicateType).toBe("https://reranker.co/attestations/model-regime/v1");
  expect(statement.subject).toEqual([{ name: "capture_envelope", digest: { sha256: sha("c") } }]);
  expect(statement.predicate).toEqual({
    ...regime,
    cause: "model",
    time: { worker_utc: SIGNED_AT.toISOString() },
    worker: { id: "vercel:iad1", image_digest: `git:${COMMIT}` },
  });
  const first = buildModelRegimeStatement({
    regime: { ...regime, from: null },
    firstCaptureEnvelopeSha256: sha("c"),
    signedAt: SIGNED_AT,
  });
  expect(ModelRegimeStatementV1Schema.safeParse(first).success).toBe(true);
  expect(
    ModelRegimeStatementV1Schema.safeParse({
      ...statement,
      predicate: { ...statement.predicate, first_capture_id: "capture-1" },
    }).success,
  ).toBe(false);
});
