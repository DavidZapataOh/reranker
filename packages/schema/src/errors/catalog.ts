// A published code is never renamed or removed; adding one is a compatible change.
export const ERRORS = {
  invalid_request: { status: 400, retryable: false },
  validation_failed: { status: 422, retryable: false },
  unauthenticated: { status: 401, retryable: false },
  forbidden: { status: 403, retryable: false },
  data_policy_required: { status: 403, retryable: false },
  not_found: { status: 404, retryable: false },
  conflict: { status: 409, retryable: false },
  rate_limited: { status: 429, retryable: true, retryAfterSeconds: 60 },
  turnstile_failed: { status: 403, retryable: false },
  idempotency_key_required: { status: 400, retryable: false },
  idempotency_key_reused: { status: 422, retryable: false },
  consent_required: { status: 422, retryable: false },
  business_not_found: { status: 422, retryable: false },
  evidence_not_found: { status: 404, retryable: false },
  spend_cap_reached: { status: 503, retryable: true, retryAfterSeconds: 3600 },
  capacity_unavailable: { status: 503, retryable: true, retryAfterSeconds: 30 },
  free_report_unavailable: { status: 503, retryable: true, retryAfterSeconds: 300 },
  provider_unavailable: { status: 503, retryable: true, retryAfterSeconds: 60 },
  service_unavailable: { status: 503, retryable: true, retryAfterSeconds: 30 },
  timeout: { status: 504, retryable: true, retryAfterSeconds: 5 },
  internal: { status: 500, retryable: false },
} as const satisfies Record<
  string,
  { status: number; retryable: boolean; retryAfterSeconds?: number }
>;

export type ErrorCode = keyof typeof ERRORS;

export const ERROR_CODES = Object.keys(ERRORS) as ErrorCode[];
