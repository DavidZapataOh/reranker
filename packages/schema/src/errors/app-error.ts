import { ERRORS, type ErrorCode, isErrorCode } from "./catalog";

export type FieldError = {
  readonly pointer: string;
  readonly code: string;
  readonly params?: Record<string, unknown>;
};

export type AppErrorOptions = {
  detail?: string;
  params?: Record<string, string | number>;
  retryAfterSeconds?: number;
  fieldErrors?: ReadonlyArray<FieldError>;
  cause?: unknown;
};

// A global symbol survives duplicated module copies across bundles, where `instanceof` fails.
const BRAND = Symbol.for("reranker.app_error");

// A wait only makes sense for retryable codes; fractions round up so clients never retry early.
function normalizeRetryAfter(retryable: boolean, seconds: number | undefined): number | undefined {
  if (!retryable || seconds === undefined || !Number.isFinite(seconds)) return undefined;
  return Math.max(1, Math.ceil(seconds));
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly retryable: boolean;
  readonly params: Record<string, string | number> | undefined;
  readonly retryAfterSeconds: number | undefined;
  readonly fieldErrors: ReadonlyArray<FieldError> | undefined;
  readonly [BRAND] = true;

  // `detail` is only for logs: the message never reaches a response.
  constructor(code: ErrorCode, options: AppErrorOptions = {}) {
    super(
      options.detail ?? code,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "AppError";
    this.code = code;
    this.status = ERRORS[code].status;
    this.retryable = ERRORS[code].retryable;
    this.params = options.params;
    this.retryAfterSeconds = normalizeRetryAfter(this.retryable, options.retryAfterSeconds);
    this.fieldErrors = options.fieldErrors;
  }
}

export function isAppError(value: unknown): value is AppError {
  if (value instanceof AppError) return true;
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<symbol, unknown>)[BRAND] === true &&
    isErrorCode((value as { code?: unknown }).code)
  );
}
