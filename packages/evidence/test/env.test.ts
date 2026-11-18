import { defineEnv, type EnvValidationError } from "@reranker/env";
import { afterEach, expect, test, vi } from "vitest";
import { evidenceEnv, getEvidenceEnv, resetEvidenceEnv } from "../src/env";
import { previewEnv, productionEnv } from "./support/evidence-env";

afterEach(() => {
  vi.unstubAllEnvs();
  resetEvidenceEnv();
});

test("production requires every KMS and R2 variable and forbids anything that looks like a private key", () => {
  expect(() => defineEnv([evidenceEnv], { APP_ENV: "production" })).toThrow(
    /EVIDENCE_CAPTURE_KMS_KEY_ARN/,
  );
  expect(
    Object.keys(evidenceEnv.shape).some(
      (k) =>
        (k.includes("PRIVATE") || k.endsWith("SECRET_KEY") || k.endsWith("_SK")) &&
        k !== "R2_SECRET_ACCESS_KEY",
    ),
  ).toBe(false);
});

test("names every production variable that is missing, except the qtsa.eu purchase", () => {
  try {
    defineEnv([evidenceEnv], { APP_ENV: "production" });
    expect.unreachable();
  } catch (error) {
    const names = (error as EnvValidationError).issues.map((i) => i.name);
    expect(names).toEqual(
      Object.keys(evidenceEnv.shape).filter((name) => !name.startsWith("QTSA_")),
    );
  }
});

test("a complete production environment parses, base URLs lose a trailing slash", () => {
  const env = defineEnv([evidenceEnv], {
    ...productionEnv,
    EVIDENCE_ARTIFACTS_BASE_URL: "https://ev.reranker.co/",
  });
  expect(env.EVIDENCE_ARTIFACTS_BASE_URL).toBe("https://ev.reranker.co");
  expect(env.QTSA_PACKAGE_SIZE).toBe(12_000);
});

test("preview may run without the variables and still validates the ones it has", () => {
  expect(() => defineEnv([evidenceEnv], { APP_ENV: "preview" })).not.toThrow();
  expect(() => defineEnv([evidenceEnv], { ...previewEnv, R2_EVIDENCE_BUCKET: "RR_Bad" })).toThrow(
    /R2_EVIDENCE_BUCKET \(invalid\)/,
  );
  expect(() =>
    defineEnv([evidenceEnv], { ...previewEnv, EVIDENCE_LOG_BASE_URL: "http://log.reranker.co" }),
  ).toThrow(/EVIDENCE_LOG_BASE_URL \(invalid\)/);
});

test("QTSA variables are forbidden outside production", () => {
  expect(() => defineEnv([evidenceEnv], { ...previewEnv, QTSA_TSA_URL: "https://x" })).toThrow(
    /QTSA_TSA_URL/,
  );
  expect(() =>
    defineEnv([evidenceEnv], { APP_ENV: "development", QTSA_PACKAGE_SIZE: "6000" }),
  ).toThrow(/QTSA_PACKAGE_SIZE \(forbidden\)/);
});

test("getEvidenceEnv reads process.env once until reset", () => {
  for (const [name, value] of Object.entries(previewEnv)) vi.stubEnv(name, value);
  expect(getEvidenceEnv().R2_EVIDENCE_BUCKET).toBe("rr-evidence-preview");
  vi.stubEnv("R2_EVIDENCE_BUCKET", "rr-evidence-other");
  expect(getEvidenceEnv().R2_EVIDENCE_BUCKET).toBe("rr-evidence-preview");
  resetEvidenceEnv();
  expect(getEvidenceEnv().R2_EVIDENCE_BUCKET).toBe("rr-evidence-other");
});
