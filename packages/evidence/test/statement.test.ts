import { EnvValidationError } from "@reranker/env";
import { CaptureStatementV1Schema, PREDICATE } from "@reranker/verify/format";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  buildCaptureStatement,
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
