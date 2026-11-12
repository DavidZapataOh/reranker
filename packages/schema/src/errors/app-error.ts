import { ERRORS, type ErrorCode } from "./catalog.ts";

// A registered symbol survives duplicate copies of this module across bundles, where instanceof fails.
const BRAND = Symbol.for("reranker.app_error");

export type FieldError = {
  readonly pointer: string;
  readonly code: string;
  readonly params?: Record<string, unknown>;
};

export type AppErrorOptions = {
  /** Goes to logs only, never to the response. */
  detail?: string;
  params?: Record<string, string | number>;
  retryAfterSeconds?: number;
  fieldErrors?: ReadonlyArray<FieldError>;
  cause?: unknown;
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly retryable: boolean;
  readonly retryAfterSeconds: number | undefined;
  readonly params: Readonly<Record<string, string | number>> | undefined;
  readonly fieldErrors: ReadonlyArray<FieldError> | undefined;
  readonly [BRAND] = true;

  constructor(code: ErrorCode, options: AppErrorOptions = {}) {
    super(
      options.detail === undefined ? code : `${code}: ${options.detail}`,
      "cause" in options ? { cause: options.cause } : undefined,
    );
    this.name = "AppError";
    this.code = code;
    this.status = ERRORS[code].status;
    this.retryable = ERRORS[code].retryable;
    this.retryAfterSeconds = options.retryAfterSeconds;
    this.params = options.params;
    this.fieldErrors = options.fieldErrors;
  }
}

export function isAppError(value: unknown): value is AppError {
  return (
    value instanceof AppError ||
    (typeof value === "object" &&
      value !== null &&
      (value as Record<symbol, unknown>)[BRAND] === true)
  );
}
