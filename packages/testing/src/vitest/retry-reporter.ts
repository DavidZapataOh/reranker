import { relative } from "node:path";
import type { Reporter, TestCase } from "vitest/node";

type AttemptError = NonNullable<ReturnType<TestCase["attempts"]>[number]["errors"]>[number];

// Fields that classify a failure without carrying a provider's body, a request or a secret.
const SAFE_FIELDS = ["code", "status", "retryAfterMs", "provider", "scope"] as const;
const MAX_CAUSES = 3;

function scalar(value: unknown): string | undefined {
  return typeof value === "string" || typeof value === "number" ? String(value) : undefined;
}

function classify(error: AttemptError, root: string): string {
  const parts: string[] = [];
  let current: AttemptError | undefined = error;
  for (let depth = 0; current && depth < MAX_CAUSES; depth++) {
    const fields = SAFE_FIELDS.flatMap((field) => {
      const value = scalar(current?.[field]);
      return value === undefined ? [] : [`${field}=${value}`];
    });
    parts.push([current.name ?? "Error", ...fields].join(" "));
    current = current.cause;
  }
  const frame = error.stacks?.[0];
  const at = frame ? ` at ${relative(root, frame.file)}:${frame.line}` : "";
  return `${parts.join(" <- ")}${at}`;
}

/**
 * The lines a test's failed attempts leave when a later attempt ran after them: the error class
 * and its code, status and wait, never the message, which can echo a provider's body.
 */
export function retriedAttemptLines(testCase: TestCase, root: string): string[] {
  const attempts = testCase.attempts();
  const last = attempts.length - 1;
  const where = `${relative(root, testCase.module.moduleId)} > ${testCase.fullName}`;
  return attempts.flatMap((attempt, index) => {
    if (attempt.state !== "failed" || index === last) return [];
    const causes = (attempt.errors ?? []).map((error) => classify(error, root)).join("; ");
    const took = Math.round(attempt.duration);
    return [`retried ${where}: attempt ${index + 1} failed after ${took} ms: ${causes}`];
  });
}

/** Prints why a retried attempt failed, which the default reporter drops once a retry passes. */
export default class RetryReporter implements Reporter {
  onTestCaseResult(testCase: TestCase): void {
    const root = testCase.project.config.root;
    for (const line of retriedAttemptLines(testCase, root)) {
      // A warning annotation keeps the cause on the run summary, next to the failures.
      process.stdout.write(
        `${process.env.GITHUB_ACTIONS === "true" ? "::warning::" : ""}${line}\n`,
      );
    }
  }
}
