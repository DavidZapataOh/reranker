import { getTranslator } from "@reranker/i18n";
import { expect, test } from "vitest";
import {
  AppError,
  ERROR_CODES,
  ERRORS,
  isAppError,
  PROBLEM_CONTENT_TYPE,
  ProblemDetails,
  toProblem,
  z,
} from "../../src/index";

const t = getTranslator("es-CO", "errors");

test("rate_limited problem validates with Spanish title and retry_after", () => {
  const p = toProblem(new AppError("rate_limited", { retryAfterSeconds: 30 }), {
    locale: "es-CO",
    requestId: "iad1::abc",
  });
  expect(ProblemDetails.parse(p)).toMatchObject({
    status: 429,
    type: "https://reranker.co/errores/rate_limited",
    retry_after: 30,
    request_id: "iad1::abc",
    code: "rate_limited",
  });
  expect(p.title).toBe(t("rate_limited.title"));
  expect(p.detail).toBe(t("rate_limited.detail", { seconds: 30, minutes: 1, hours: 0 }));
  expect(p.detail).toContain("30");
});

test("retryable codes always carry retry_after", () => {
  for (const code of ERROR_CODES.filter((c) => ERRORS[c].retryable)) {
    const p = toProblem(new AppError(code), { locale: "es-CO" });
    expect(p.retry_after).toBeGreaterThan(0);
    expect(() => ProblemDetails.parse(p)).not.toThrow();
  }
});

test("every code produces a valid problem without retry_after unless retryable", () => {
  for (const code of ERROR_CODES) {
    const p = ProblemDetails.parse(toProblem(new AppError(code), { locale: "es-CO" }));
    expect(p.status).toBe(ERRORS[code].status);
    expect(p.request_id).toBeNull();
    expect("retry_after" in p).toBe(ERRORS[code].retryable);
    expect(p.detail).not.toMatch(/errors\./);
  }
});

test("ProblemDetails rejects a retryable problem without retry_after and unknown members", () => {
  const base = {
    type: "https://reranker.co/errores/timeout",
    title: "x",
    status: 504,
    detail: "x",
    code: "timeout",
    request_id: null,
  };
  expect(ProblemDetails.safeParse(base).success).toBe(false);
  expect(ProblemDetails.safeParse({ ...base, retry_after: 5 }).success).toBe(true);
  expect(ProblemDetails.safeParse({ ...base, retry_after: 5, stack: "x" }).success).toBe(false);
  expect(ProblemDetails.safeParse({ ...base, retry_after: 5, status: 200 }).success).toBe(false);
  expect(z.globalRegistry.get(ProblemDetails)?.id).toBe("ProblemDetails");
});

test("instance is passed through", () => {
  const p = toProblem(new AppError("not_found"), { locale: "es-CO", instance: "/reportes/1" });
  expect(p.instance).toBe("/reportes/1");
});

test("unknown errors become internal without leaking", () => {
  const p = toProblem(new Error("x"), { locale: "es-CO" });
  expect(p.code).toBe("internal");
  expect(p.status).toBe(500);
  expect(JSON.stringify(p)).not.toContain('"x"');
  const q = toProblem(
    new AppError("internal", { detail: "db password=hunter2", cause: new Error("secret") }),
    { locale: "es-CO" },
  );
  expect(JSON.stringify(q)).not.toMatch(/hunter2|secret/);
  expect(q.detail).toBe(t("internal.detail"));
  expect(toProblem("string thrown", { locale: "es-CO" }).code).toBe("internal");
  expect(toProblem(null, { locale: "es-CO" }).code).toBe("internal");
});

test("internal detail stays generic even with params", () => {
  const p = toProblem(new AppError("internal", { params: { table: "users" } }), {
    locale: "es-CO",
  });
  expect(p.detail).toBe(t("internal.detail"));
});

test("AppError keeps the internal detail for logs only", () => {
  const cause = new Error("root");
  const e = new AppError("conflict", { detail: "unique violation on leads.email", cause });
  expect(e).toBeInstanceOf(Error);
  expect(e.message).toBe("unique violation on leads.email");
  expect(e.cause).toBe(cause);
  expect(e.name).toBe("AppError");
  expect(e).toMatchObject({ code: "conflict", status: 409, retryable: false });
  expect(new AppError("conflict").message).toBe("conflict");
});

test("isAppError recognizes copies from another bundle by brand", () => {
  expect(isAppError(new AppError("forbidden"))).toBe(true);
  expect(isAppError(new Error("forbidden"))).toBe(false);
  expect(isAppError(null)).toBe(false);
  const foreign = Object.assign(new Error("x"), {
    [Symbol.for("reranker.app_error")]: true,
    code: "forbidden",
    status: 403,
    retryable: false,
  });
  expect(isAppError(foreign)).toBe(true);
  expect(toProblem(foreign, { locale: "es-CO" }).code).toBe("forbidden");
});

test("a branded value with an unknown code becomes internal", () => {
  const forged = { [Symbol.for("reranker.app_error")]: true, code: "nope" };
  expect(toProblem(forged, { locale: "es-CO" }).code).toBe("internal");
});

test("problem content type", () => {
  expect(PROBLEM_CONTENT_TYPE).toBe("application/problem+json");
});

test("caller wait times are rounded up to whole seconds and never below one", () => {
  const wait = (value: number) => new AppError("rate_limited", { retryAfterSeconds: value });
  expect(wait(30.5).retryAfterSeconds).toBe(31);
  expect(wait(0).retryAfterSeconds).toBe(1);
  expect(wait(-5).retryAfterSeconds).toBe(1);
  expect(wait(Number.NaN).retryAfterSeconds).toBeUndefined();
  expect(wait(Number.POSITIVE_INFINITY).retryAfterSeconds).toBeUndefined();
  const p = toProblem(wait(30.5), { locale: "es-CO" });
  expect(p.retry_after).toBe(31);
  expect(p.detail).toContain("31 segundos");
  expect(ProblemDetails.safeParse(p).success).toBe(true);
});

test("a non-finite wait falls back to the code default", () => {
  const p = toProblem(new AppError("rate_limited", { retryAfterSeconds: Number.NaN }), {
    locale: "es-CO",
  });
  expect(p.retry_after).toBe(60);
});

test("non-retryable codes ignore a caller wait", () => {
  const e = new AppError("not_found", { retryAfterSeconds: 30 });
  expect(e.retryAfterSeconds).toBeUndefined();
  expect("retry_after" in toProblem(e, { locale: "es-CO" })).toBe(false);
});

test("long waits are spoken in hours", () => {
  const p = toProblem(new AppError("spend_cap_reached"), { locale: "es-CO" });
  expect(p.retry_after).toBe(3600);
  expect(p.detail).toContain("1 hora");
  expect(p.detail).not.toMatch(/60 minutos|hoy/);
  expect(p.title).not.toMatch(/hoy/);
  const two = toProblem(new AppError("spend_cap_reached", { retryAfterSeconds: 7200 }), {
    locale: "es-CO",
  });
  expect(two.detail).toContain("2 horas");
  const short = toProblem(new AppError("spend_cap_reached", { retryAfterSeconds: 300 }), {
    locale: "es-CO",
  });
  expect(short.detail).toContain("5 minutos");
});
