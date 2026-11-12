import { ERRORS, type ErrorCode } from "./catalog.ts";

export type AppErrorOptions = {
  detail?: string;
  params?: Record<string, string | number>;
  retryAfterSeconds?: number;
  fieldErrors?: ReadonlyArray<{ pointer: string; code: string; params?: Record<string, unknown> }>;
  cause?: unknown;
};

// A registry symbol instead of a module-local one, so the mark survives duplicated module copies across bundles.
const MARK = Symbol.for("reranker.app_error");

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly retryable: boolean;
  readonly params: Record<string, string | number> | undefined;
  readonly retryAfterSeconds: number | undefined;
  readonly fieldErrors: AppErrorOptions["fieldErrors"];
  readonly [MARK] = true;

  constructor(code: ErrorCode, options: AppErrorOptions = {}) {
    // The detail only reaches logs through the message, never a response body.
    super(options.detail === undefined ? code : `${code}: ${options.detail}`, {
      cause: options.cause,
    });
    this.name = "AppError";
    this.code = code;
    this.status = ERRORS[code].status;
    this.retryable = ERRORS[code].retryable;
    this.params = options.params;
    this.retryAfterSeconds = options.retryAfterSeconds;
    this.fieldErrors = options.fieldErrors;
  }
}

export function isAppError(value: unknown): value is AppError {
  return (
    value instanceof AppError ||
    (typeof value === "object" &&
      value !== null &&
      (value as Record<symbol, unknown>)[MARK] === true)
  );
}
