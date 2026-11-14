import { defineEnv } from "@reranker/env";
import { describe, expect, test } from "vitest";
import { telemetryEnv } from "./env";

const posthog = { POSTHOG_PROJECT_TOKEN: "phc_test", POSTHOG_HOST: "https://us.i.posthog.com" };

describe("telemetry environment", () => {
  test("development needs nothing beyond APP_ENV", () => {
    expect(defineEnv([telemetryEnv], { APP_ENV: "development" })).toEqual({
      APP_ENV: "development",
      LOG_LEVEL: "info",
    });
  });

  test("preview and production require the PostHog project token and host", () => {
    for (const APP_ENV of ["preview", "production"]) {
      expect(() => defineEnv([telemetryEnv], { APP_ENV })).toThrowError(
        /POSTHOG_PROJECT_TOKEN \(missing\), POSTHOG_HOST \(missing\)/,
      );
      expect(defineEnv([telemetryEnv], { APP_ENV, ...posthog })).toMatchObject(posthog);
    }
  });

  test("an empty value counts as missing and the token must be a project key", () => {
    expect(() =>
      defineEnv([telemetryEnv], { APP_ENV: "production", ...posthog, POSTHOG_PROJECT_TOKEN: "" }),
    ).toThrowError(/POSTHOG_PROJECT_TOKEN \(missing\)/);
    expect(() =>
      defineEnv([telemetryEnv], { APP_ENV: "production", ...posthog, POSTHOG_PROJECT_TOKEN: "x" }),
    ).toThrowError(/POSTHOG_PROJECT_TOKEN \(invalid\)/);
  });

  test("the operations variables stay optional until their task consumes them", () => {
    expect(defineEnv([telemetryEnv], { APP_ENV: "production", ...posthog })).toEqual({
      APP_ENV: "production",
      LOG_LEVEL: "info",
      ...posthog,
    });
  });

  test("validates the operations variables when present", () => {
    expect(() =>
      defineEnv([telemetryEnv], {
        APP_ENV: "development",
        OPS_ALERT_EMAIL: "nope",
        LOG_LEVEL: "loud",
        BETTERSTACK_HEARTBEAT_DAILY_URL: "nope",
      }),
    ).toThrowError(/OPS_ALERT_EMAIL \(invalid\).*LOG_LEVEL \(invalid\)/);
  });
});
