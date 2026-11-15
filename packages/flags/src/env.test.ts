import { defineEnv } from "@reranker/env";
import { telemetryEnv } from "@reranker/telemetry/env";
import { expect, test } from "vitest";
import { flagsEnv } from "./env";

const posthog = { POSTHOG_PROJECT_TOKEN: "phc_test", POSTHOG_HOST: "https://us.i.posthog.com" };

test("the flags key is optional until it exists in every environment", () => {
  for (const APP_ENV of ["development", "preview", "production"]) {
    expect(
      defineEnv([flagsEnv], { APP_ENV, ...posthog }).POSTHOG_FEATURE_FLAGS_KEY,
    ).toBeUndefined();
  }
});

test("the flags key must be a project secret key and an empty value counts as unset", () => {
  const env = { APP_ENV: "production", ...posthog };
  expect(defineEnv([flagsEnv], { ...env, POSTHOG_FEATURE_FLAGS_KEY: "phs_abc" })).toMatchObject({
    POSTHOG_FEATURE_FLAGS_KEY: "phs_abc",
  });
  expect(() =>
    defineEnv([flagsEnv], { ...env, POSTHOG_FEATURE_FLAGS_KEY: "phc_abc" }),
  ).toThrowError(/POSTHOG_FEATURE_FLAGS_KEY \(invalid\)/);
  expect(
    defineEnv([flagsEnv], { ...env, POSTHOG_FEATURE_FLAGS_KEY: "" }).POSTHOG_FEATURE_FLAGS_KEY,
  ).toBeUndefined();
});

test("token and host are the telemetry declarations, not copies", () => {
  expect(flagsEnv.shape.POSTHOG_PROJECT_TOKEN).toBe(telemetryEnv.shape.POSTHOG_PROJECT_TOKEN);
  expect(flagsEnv.shape.POSTHOG_HOST).toBe(telemetryEnv.shape.POSTHOG_HOST);
  expect(flagsEnv.shape.POSTHOG_FEATURE_FLAGS_KEY.meta()).toMatchObject({ kind: "secret" });
});
