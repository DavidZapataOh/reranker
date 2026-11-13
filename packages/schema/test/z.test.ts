import { getTranslator } from "@reranker/i18n";
import { expect, test } from "vitest";
import { z } from "../src/index";

const t = getTranslator("es-CO", "errors.validation");

test("issues without a custom message fall back to Spanish", () => {
  const r = z.object({ n: z.number() }).safeParse({ n: "x" });
  expect(r.error?.issues[0]?.message).not.toMatch(/expected|received|string|number/i);
});

test("custom messages come from errors.validation.<code> and never echo input", () => {
  const r = z.string().min(3).safeParse("ab");
  expect(r.error?.issues[0]?.message).toBe(t("too_small", { origin: "string", minimum: 3 }));
  expect(r.error?.issues[0]?.message).not.toContain("ab");
});

test("format issues pick the message for the failed format", () => {
  const r = z.email().safeParse("nope");
  expect(r.error?.issues[0]?.message).toBe(t("invalid_format", { format: "email" }));
});

test("every translated issue code uses its catalog message", () => {
  const cases = [
    [z.number().safeParse("x"), t("invalid_type", { expected: "number" })],
    [
      z.number().max(1).safeParse(5),
      t("too_big", { origin: "number", maximum: 1, inclusive: "true" }),
    ],
    [z.number().multipleOf(3).safeParse(4), t("not_multiple_of", { divisor: 3 })],
    [z.strictObject({}).safeParse({ x: 1 }), t("unrecognized_keys", { count: 1 })],
    [z.union([z.string(), z.number()]).safeParse(true), t("invalid_union")],
    [z.enum(["a"]).safeParse("b"), t("invalid_value")],
    [z.record(z.string().min(2), z.string()).safeParse({ a: "x" }), t("invalid_key")],
    [
      z
        .string()
        .refine(() => false)
        .safeParse("x"),
      t("custom"),
    ],
  ] as const;
  for (const [r, expected] of cases) {
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.message).toBe(expected);
  }
});

test("messages never echo the submitted input", () => {
  const email = z.object({ email: z.email() }).safeParse({ email: "secreto@x" });
  const strict = z.strictObject({}).safeParse({ llaveSecreta: 1 });
  const messages = [...(email.error?.issues ?? []), ...(strict.error?.issues ?? [])].map(
    (i) => i.message,
  );
  expect(messages).toHaveLength(2);
  for (const m of messages) expect(m).not.toMatch(/secreto|llaveSecreta/);
});

test("bigint bounds are forwarded as numbers", () => {
  const r = z.bigint().min(5n).safeParse(1n);
  expect(r.error?.issues[0]?.message).toBe(t("too_small", { origin: "bigint", minimum: 5 }));
});

test("codes outside the catalog fall back to the Spanish locale", () => {
  const r = z
    .string()
    .superRefine((_, ctx) => {
      ctx.addIssue({ code: "not_a_code" } as never);
    })
    .safeParse("x");
  expect(r.error?.issues[0]?.message).toBeTypeOf("string");
  expect(r.error?.issues[0]?.message).not.toMatch(/Invalid|expected|received/);
});

test("exclusive bounds read as strictly greater", () => {
  const r = z.number().gt(5).safeParse(1);
  expect(r.error?.issues[0]?.message).toBe(
    t("too_small", { origin: "number", minimum: 5, inclusive: "false" }),
  );
  expect(r.error?.issues[0]?.message).toContain("mayor que");
});

test("invalid_element is translated when raised manually", () => {
  const r = z
    .string()
    .superRefine((_, ctx) => {
      ctx.addIssue({ code: "invalid_element" } as never);
    })
    .safeParse("x");
  expect(r.error?.issues[0]?.message).toBe(t("invalid_element"));
});

test("a refinement names its catalog message through params.code", () => {
  const specific = z
    .string()
    .refine(() => false, { params: { code: "invalid_value" } })
    .safeParse("x");
  expect(specific.error?.issues[0]?.message).toBe(t("invalid_value"));
  const unknown = z
    .string()
    .refine(() => false, { params: { code: "no_such_rule" } })
    .safeParse("x");
  expect(unknown.error?.issues[0]?.message).toBe(t("custom"));
});
