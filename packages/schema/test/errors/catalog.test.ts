import { getTranslator } from "@reranker/i18n";
import { expect, test } from "vitest";
import { ERROR_CODES, ERRORS, IdempotencyKeyHeader } from "../../src/index";

test("catalog is exactly the published table", () => {
  const table = Object.fromEntries(
    Object.entries(ERRORS).map(([code, { status, retryable }]) => [code, [status, retryable]]),
  );
  expect(table).toEqual({
    invalid_request: [400, false],
    validation_failed: [422, false],
    unauthenticated: [401, false],
    forbidden: [403, false],
    data_policy_required: [403, false],
    not_found: [404, false],
    conflict: [409, false],
    rate_limited: [429, true],
    turnstile_failed: [403, false],
    idempotency_key_required: [400, false],
    idempotency_key_reused: [422, false],
    consent_required: [422, false],
    business_not_found: [422, false],
    evidence_not_found: [404, false],
    spend_cap_reached: [503, true],
    capacity_unavailable: [503, true],
    free_report_unavailable: [503, true],
    provider_unavailable: [503, true],
    service_unavailable: [503, true],
    timeout: [504, true],
    internal: [500, false],
  });
  expect(ERROR_CODES).toHaveLength(21);
  expect(ERROR_CODES).toEqual(Object.keys(ERRORS));
});

test("retryable codes carry a positive default wait and the rest carry none", () => {
  for (const code of ERROR_CODES) {
    const entry: { retryable: boolean; retryAfterSeconds?: number } = ERRORS[code];
    if (entry.retryable) expect(entry.retryAfterSeconds).toBeGreaterThan(0);
    else expect(entry.retryAfterSeconds).toBeUndefined();
  }
});

test("every code has title, detail and action in es-CO without technical codes", () => {
  const t = getTranslator("es-CO", "errors");
  const params = { seconds: 30, minutes: 1, hours: 0 };
  for (const code of ERROR_CODES) {
    for (const key of ["title", "detail", "action"] as const) {
      const id = `${code}.${key}` as Parameters<typeof t>[0];
      expect(t.has(id)).toBe(true);
      const text = t(id, params);
      expect(text).not.toMatch(new RegExp(code));
      expect(text).not.toMatch(/errors\.|[a-z]+_[a-z]+|soporte|contact/i);
      expect(text.trim().length).toBeGreaterThan(0);
    }
  }
});

test("business_not_found is neutral about the country", () => {
  const t = getTranslator("es-CO", "errors");
  expect(t("business_not_found.title")).toBe("No encontramos ese negocio");
  expect(t("business_not_found.detail")).not.toMatch(/Colombia/);
});

test("IdempotencyKeyHeader requires a uuid", () => {
  expect(IdempotencyKeyHeader.safeParse({ "idempotency-key": crypto.randomUUID() }).success).toBe(
    true,
  );
  expect(IdempotencyKeyHeader.safeParse({ "idempotency-key": "abc" }).success).toBe(false);
  expect(IdempotencyKeyHeader.safeParse({}).success).toBe(false);
});
