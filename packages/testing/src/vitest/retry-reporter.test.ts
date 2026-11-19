import { expect, test } from "vitest";
import type { TestCase } from "vitest/node";
import { retriedAttemptLines } from "./retry-reporter";

const ROOT = "/repo/packages/extraction";

function testCase(attempts: Array<{ state: "passed" | "failed"; errors?: unknown[] }>): TestCase {
  return {
    fullName: "a real answer comes back",
    module: { moduleId: `${ROOT}/test/providers/openai.contract.test.ts` },
    attempts: () => attempts.map((attempt) => ({ duration: 1234.4, ...attempt })),
  } as unknown as TestCase;
}

test("a failed attempt a retry hid is reported by class, code, status and wait", () => {
  const rateLimited = {
    name: "RateLimited",
    message: "Rate limited by OpenAI, retry in 2000 ms",
    retryAfterMs: 2000,
    status: 429,
    stacks: [{ file: `${ROOT}/src/providers/openai.ts`, line: 57, column: 11, method: "" }],
  };
  expect(
    retriedAttemptLines(
      testCase([{ state: "failed", errors: [rateLimited] }, { state: "passed" }]),
      ROOT,
    ),
  ).toEqual([
    "retried test/providers/openai.contract.test.ts > a real answer comes back: attempt 1 failed after 1234 ms: RateLimited status=429 retryAfterMs=2000 at src/providers/openai.ts:57",
  ]);
});

test("the message and any body stay out; causes are named down the chain", () => {
  const fetchFailed = {
    name: "EvidenceStorageUnavailable",
    message: "R2 PUT bucket/key failed: secret-looking body",
    response: '{"error":"body"}',
    cause: {
      name: "TypeError",
      message: "fetch failed",
      cause: { name: "Error", code: "UND_ERR_CONNECT_TIMEOUT" },
    },
  };
  const [line] = retriedAttemptLines(
    testCase([{ state: "failed", errors: [fetchFailed] }, { state: "passed" }]),
    ROOT,
  );
  expect(line).toContain(
    "EvidenceStorageUnavailable <- TypeError <- Error code=UND_ERR_CONNECT_TIMEOUT",
  );
  expect(line).not.toContain("body");
  expect(line).not.toContain("fetch failed");
});

test("the last attempt is left to the default reporter, and a clean pass prints nothing", () => {
  const failed = { name: "AssertionError", message: "expected 1 to be 2" };
  expect(
    retriedAttemptLines(
      testCase([
        { state: "failed", errors: [failed] },
        { state: "failed", errors: [failed] },
      ]),
      ROOT,
    ),
  ).toHaveLength(1);
  expect(retriedAttemptLines(testCase([{ state: "passed" }]), ROOT)).toEqual([]);
});
