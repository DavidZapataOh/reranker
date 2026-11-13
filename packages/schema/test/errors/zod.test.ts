import { getTranslator } from "@reranker/i18n";
import { expect, test } from "vitest";
import { AppError, Email, fromZodError, toProblem, z } from "../../src/index";

const v = getTranslator("es-CO", "errors.validation");

function failure(result: { success: boolean; error?: z.ZodError }): z.ZodError {
  if (!result.error) throw new Error("expected the parse to fail");
  return result.error;
}

test("an invalid email becomes validation_failed with a Spanish field error", () => {
  const r = z.object({ email: Email }).safeParse({ email: "ana@@x" });
  const p = toProblem(fromZodError(failure(r), "body"), { locale: "es-CO" });
  expect(p.code).toBe("validation_failed");
  expect(p.status).toBe(422);
  expect(p.errors?.[0]?.pointer).toBe("/body/email");
  expect(p.errors?.[0]?.code).toBe("invalid_format");
  expect(p.errors?.[0]?.detail).not.toContain("ana@@x");
  expect(p.errors?.[0]?.detail).toMatch(/correo/);
  expect(JSON.stringify(p)).not.toContain("ana@@x");
});

test("pointer escapes ~ and / (RFC 6901)", () => {
  const r = z.object({ "a/b": z.object({ "c~d": z.string() }) }).safeParse({ "a/b": { "c~d": 1 } });
  expect(fromZodError(failure(r), "headers").fieldErrors?.[0]?.pointer).toBe("/headers/a~1b/c~0d");
});

test("array indexes and root issues get pointers", () => {
  const r = z.array(z.string().min(2)).safeParse(["ok", "x"]);
  const e = fromZodError(failure(r), "query");
  expect(e.fieldErrors?.[0]).toEqual({
    pointer: "/query/1",
    code: "too_small",
    params: { origin: "string", minimum: 2, inclusive: "true" },
  });
  const root = fromZodError(failure(z.string().safeParse(1)), "form");
  expect(root.fieldErrors?.[0]?.pointer).toBe("/form");
});

test("field error params never carry the input", () => {
  const r = z.object({ name: z.string().max(3) }).safeParse({ name: "secreto" });
  const e = fromZodError(failure(r), "body");
  expect(JSON.stringify(e.fieldErrors)).not.toContain("secreto");
  expect(e).toBeInstanceOf(AppError);
  expect(e.code).toBe("validation_failed");
});

test("field error details use errors.validation and fall back to custom", () => {
  const p = toProblem(
    new AppError("consent_required", {
      fieldErrors: [
        { pointer: "/form/consent", code: "unknown_rule" },
        { pointer: "/form/name", code: "too_small", params: { origin: "string", minimum: 2 } },
        { pointer: "/form/x", code: "invalid_format", params: { format: { nested: 1 } } },
      ],
    }),
    { locale: "es-CO" },
  );
  expect(p.errors).toEqual([
    { pointer: "/form/consent", code: "unknown_rule", detail: v("custom") },
    {
      pointer: "/form/name",
      code: "too_small",
      detail: v("too_small", { origin: "string", minimum: 2 }),
    },
    { pointer: "/form/x", code: "invalid_format", detail: v("custom") },
  ]);
});

test("a refinement's catalog code becomes the field error code", () => {
  const r = z
    .object({ plan: z.string().refine(() => false, { params: { code: "invalid_value" } }) })
    .safeParse({ plan: "x" });
  const p = toProblem(fromZodError(failure(r), "body"), { locale: "es-CO" });
  expect(p.errors).toEqual([
    { pointer: "/body/plan", code: "invalid_value", detail: v("invalid_value") },
  ]);
  const generic = z
    .string()
    .refine(() => false, { params: { code: "no_such_rule" } })
    .safeParse("x");
  expect(fromZodError(failure(generic), "body").fieldErrors?.[0]?.code).toBe("custom");
});
