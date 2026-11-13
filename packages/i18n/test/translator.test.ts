import { expect, test } from "vitest";
import { getTranslator, hasLocale } from "../src/index";

test("getTranslator reads a namespace", () => {
  expect(getTranslator("es-CO", "common")("appName")).toBe("Reranker");
});

test("hasLocale", () => {
  expect(hasLocale("es-CO")).toBe(true);
  expect(hasLocale("en")).toBe(false);
  expect(hasLocale(undefined)).toBe(false);
});

test("onError receives messages that cannot be rendered", () => {
  const errors: string[] = [];
  const t = getTranslator("es-CO", "errors.validation", {
    onError: (error) => errors.push(error.code),
  });
  t("invalid_format");
  expect(errors).toEqual(["FORMATTING_ERROR"]);
});
