import { randomBytes } from "node:crypto";
import { defineEnv } from "@reranker/env";
import { expect, test } from "vitest";
import { extractionEnv } from "../src/env";

const base = {
  APP_ENV: "development",
  OPENAI_API_KEY: "sk-proj-test",
  GEMINI_API_KEY: "gemini-test-key",
  GOOGLE_PLACES_API_KEY: "places-test-key",
  ENTITY_NAME_HMAC_KEY: randomBytes(32).toString("base64url"),
};

test("accepts the provider keys and a 32-byte name hmac key", () => {
  const env = defineEnv([extractionEnv], base);
  expect(env.ENTITY_NAME_HMAC_KEY).toBe(base.ENTITY_NAME_HMAC_KEY);
  expect(env.ANTHROPIC_API_KEY).toBeUndefined();
});

test("env requires a 32-byte name hmac key", () => {
  expect(() => defineEnv([extractionEnv], { ...base, ENTITY_NAME_HMAC_KEY: "short" })).toThrow(
    /ENTITY_NAME_HMAC_KEY/,
  );
  const thirtyOne = randomBytes(31).toString("base64url");
  expect(() => defineEnv([extractionEnv], { ...base, ENTITY_NAME_HMAC_KEY: thirtyOne })).toThrow(
    /ENTITY_NAME_HMAC_KEY/,
  );
});

test("the name hmac key is base64url, not standard base64", () => {
  const padded = randomBytes(33)
    .toString("base64")
    .replace(/[A-Za-z0-9]$/, "+");
  expect(() => defineEnv([extractionEnv], { ...base, ENTITY_NAME_HMAC_KEY: padded })).toThrow(
    /ENTITY_NAME_HMAC_KEY/,
  );
});

test("names every missing provider key at once", () => {
  expect(() => defineEnv([extractionEnv], { APP_ENV: "development" })).toThrow(
    /OPENAI_API_KEY.*GEMINI_API_KEY.*GOOGLE_PLACES_API_KEY.*ENTITY_NAME_HMAC_KEY/,
  );
});

test("an Anthropic key, when present, must be one", () => {
  expect(
    defineEnv([extractionEnv], { ...base, ANTHROPIC_API_KEY: "sk-ant-api03-x" }),
  ).toMatchObject({ ANTHROPIC_API_KEY: "sk-ant-api03-x" });
  expect(() => defineEnv([extractionEnv], { ...base, ANTHROPIC_API_KEY: "sk-proj-x" })).toThrow(
    /ANTHROPIC_API_KEY/,
  );
});

test("keys are secrets, so they never reach the browser or logs", () => {
  for (const schema of Object.values(extractionEnv.shape)) {
    expect(schema.meta()).toMatchObject({ kind: "secret" });
  }
});
