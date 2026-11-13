import type { z } from "../z";
import { issueCode, safeParams } from "../z";
import { AppError } from "./app-error";

export type ProblemRoot = "body" | "query" | "headers" | "params" | "form";

// RFC 6901: "~" must be escaped before "/" so that "~1" produced for "/" is not re-escaped.
function escapeToken(segment: PropertyKey): string {
  return String(segment).replaceAll("~", "~0").replaceAll("/", "~1");
}

export function fromZodError(error: z.ZodError, root: ProblemRoot): AppError {
  return new AppError("validation_failed", {
    detail: `Invalid ${root}`,
    fieldErrors: error.issues.map((issue) => ({
      pointer: `/${root}${issue.path.map((segment) => `/${escapeToken(segment)}`).join("")}`,
      code: issueCode(issue),
      params: safeParams(issue),
    })),
    cause: error,
  });
}
