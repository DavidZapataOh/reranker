import { type EnvIssue, EnvValidationError } from "@reranker/env";
import {
  type CaptureId,
  type CapturePredicateV1,
  type CaptureStatementV1,
  IN_TOTO_STATEMENT_V1,
  PREDICATE,
} from "@reranker/verify/format";

/** The capture predicate as the caller knows it; this package adds who signed it and when. */
export type CapturePredicateInput = Omit<CapturePredicateV1, "capture_id" | "worker" | "time">;

const GIT_SHA = /^[0-9a-f]{40}$/;

/**
 * The deployment that signs, from Vercel's system variables. Without them a statement would name
 * no code version, so signing fails closed instead of inventing one.
 */
export function workerIdentity(): { id: string; image_digest: string } {
  const region = process.env.VERCEL_REGION;
  const commit = process.env.VERCEL_GIT_COMMIT_SHA;
  const issues: EnvIssue[] = [];
  if (!region) issues.push({ name: "VERCEL_REGION", problem: "missing" });
  if (!commit) issues.push({ name: "VERCEL_GIT_COMMIT_SHA", problem: "missing" });
  else if (!GIT_SHA.test(commit))
    issues.push({ name: "VERCEL_GIT_COMMIT_SHA", problem: "invalid" });
  if (issues.length > 0) throw new EnvValidationError(issues);
  return { id: `vercel:${region}`, image_digest: `git:${commit}` };
}

export function buildCaptureStatement(input: {
  captureId: CaptureId;
  rawSha256: string;
  requestSha256: string;
  normalizedSha256: string | null;
  predicate: CapturePredicateInput;
  signedAt: Date;
}): CaptureStatementV1 {
  const subject = [
    { name: "raw", digest: { sha256: input.rawSha256 } },
    { name: "request", digest: { sha256: input.requestSha256 } },
  ];
  if (input.normalizedSha256 !== null) {
    subject.push({ name: "normalized", digest: { sha256: input.normalizedSha256 } });
  }
  return {
    _type: IN_TOTO_STATEMENT_V1,
    subject,
    predicateType: PREDICATE.capture,
    predicate: {
      capture_id: input.captureId,
      ...input.predicate,
      time: { worker_utc: input.signedAt.toISOString(), roughtime: null, not_before: null },
      worker: workerIdentity(),
    },
  };
}
