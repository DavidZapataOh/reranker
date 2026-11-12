// Same shape and brand as the shared application error, so `isAppError` and the HTTP problem
// mapper recognize database errors even across bundle copies of this module.
const APP_ERROR = Symbol.for("reranker.app_error");

export type DbErrorCode = "service_unavailable" | "timeout" | "conflict" | "internal";

export type AppErrorOptions = {
  retryAfterSeconds?: number;
  detail?: string;
  cause?: unknown;
};

export class AppError extends Error {
  readonly [APP_ERROR] = true;
  readonly code: DbErrorCode;
  readonly retryAfterSeconds: number | undefined;

  constructor(code: DbErrorCode, options: AppErrorOptions = {}) {
    super(options.detail ? `${code}: ${options.detail}` : code, { cause: options.cause });
    this.name = "AppError";
    this.code = code;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

export function isAppError(value: unknown): value is AppError {
  return (
    value instanceof AppError || (typeof value === "object" && value !== null && APP_ERROR in value)
  );
}
