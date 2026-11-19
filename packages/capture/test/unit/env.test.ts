import { defineEnv } from "@reranker/env";
import { expect, test } from "vitest";
import { captureEnv } from "../../src/env";

test.each(["preview", "production"])("missing DataForSEO credentials fail in %s", (APP_ENV) => {
  expect(() => defineEnv([captureEnv], { APP_ENV })).toThrowError(
    /DATAFORSEO_LOGIN \(missing\), DATAFORSEO_PASSWORD \(missing\)/,
  );
});

test.each(["preview", "production"])("%s accepts the credentials", (APP_ENV) => {
  const env = defineEnv([captureEnv], {
    APP_ENV,
    DATAFORSEO_LOGIN: "login",
    DATAFORSEO_PASSWORD: "password",
  });
  expect(env).toMatchObject({ DATAFORSEO_LOGIN: "login", DATAFORSEO_PASSWORD: "password" });
});

test("development runs without them", () => {
  expect(defineEnv([captureEnv], { APP_ENV: "development" }).DATAFORSEO_LOGIN).toBeUndefined();
});
