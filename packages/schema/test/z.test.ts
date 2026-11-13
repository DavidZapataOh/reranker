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

test("every translated issue code resolves without throwing", () => {
  const cases = [
    z.number().max(1).safeParse(5),
    z.number().multipleOf(3).safeParse(4),
    z.strictObject({}).safeParse({ x: 1 }),
    z.union([z.string(), z.number()]).safeParse(true),
    z.enum(["a"]).safeParse("b"),
    z.record(z.string().min(2), z.string()).safeParse({ a: "x" }),
    z.array(z.string()).safeParse([1]),
    z
      .string()
      .refine(() => false)
      .safeParse("x"),
  ];
  for (const r of cases) {
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.message).not.toMatch(/Invalid|expected|received/);
  }
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
