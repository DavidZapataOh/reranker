import { defineEnv } from "@reranker/env";
import { expect, test } from "vitest";
import { captureEnv } from "../../src/env";

test("missing DataForSEO credentials fail in production", () => {
  expect(() => defineEnv([captureEnv], { APP_ENV: "production" })).toThrowError(
    /DATAFORSEO_LOGIN \(missing\), DATAFORSEO_PASSWORD \(missing\)/,
  );
});

test("production accepts the credentials", () => {
  const env = defineEnv([captureEnv], {
    APP_ENV: "production",
    DATAFORSEO_LOGIN: "login",
    DATAFORSEO_PASSWORD: "password",
  });
  expect(env).toMatchObject({ DATAFORSEO_LOGIN: "login", DATAFORSEO_PASSWORD: "password" });
});

test("development runs without them", () => {
  expect(defineEnv([captureEnv], { APP_ENV: "development" }).DATAFORSEO_LOGIN).toBeUndefined();
});
