import { defineEnv } from "@reranker/env";
import { describe, expect, test } from "vitest";
import { fragments } from "./env";

const authVars = {
  BETTER_AUTH_SECRET: "s".repeat(32),
  NEXT_PUBLIC_GOOGLE_CLIENT_ID: "google-client-id.apps.googleusercontent.com",
  GOOGLE_CLIENT_SECRET: "google-client-secret",
  RESEND_API_KEY: "re_test",
  TURNSTILE_SECRET_KEY: "turnstile-secret",
  NEXT_PUBLIC_TURNSTILE_SITE_KEY: "turnstile-site",
  CAPACITY_HMAC_KEY: "h".repeat(32),
};

// Preview takes its auth origin from Vercel; the other environments pin it.
const origin = (APP_ENV: string) =>
  APP_ENV === "preview"
    ? { VERCEL_URL: "reranker-a1b2c3d4e-davidzapataohs-projects.vercel.app" }
    : { BETTER_AUTH_URL: "https://reranker.co" };

const posthog = {
  NEXT_PUBLIC_POSTHOG_KEY: "phc_test",
  POSTHOG_PROJECT_TOKEN: "phc_test",
  POSTHOG_HOST: "https://us.i.posthog.com",
};

const dataforseo = { DATAFORSEO_LOGIN: "login", DATAFORSEO_PASSWORD: "password" };

const brightdata = { BRIGHTDATA_API_KEY: "user-key", BRIGHTDATA_BILLING_API_KEY: "finance-key" };

const openaiControl = { OPENAI_CONTROL_API_KEY: "sk-control" };

const withoutDataforseo = (APP_ENV: string, extra: Record<string, string> = {}) =>
  defineEnv(fragments, { APP_ENV, ...authVars, ...origin(APP_ENV), ...posthog, ...extra });

const withKey = (APP_ENV: string, extra: Record<string, string> = {}) =>
  withoutDataforseo(APP_ENV, { ...dataforseo, ...extra });

describe("web environment", () => {
  test("development needs nothing beyond APP_ENV and the auth variables", () => {
    const local = { ...authVars, BETTER_AUTH_URL: "http://localhost:3000" };
    expect(defineEnv(fragments, { APP_ENV: "development", ...local })).toEqual({
      APP_ENV: "development",
      NEXT_PUBLIC_POSTHOG_REGION: "us",
      LOG_LEVEL: "info",
      POSTHOG_PLAN: "free",
      BRIGHTDATA_PERPLEXITY_DATASET_ID: "gd_m7dhdot1vw9a7gc1n",
      BRIGHTDATA_CHATGPT_DATASET_ID: "gd_m7aof0k82r803d5bjm",
      ...local,
    });
  });

  // /api/auth serves every environment, so a deployment without its variables must not start.
  test.each(["development", "preview", "production"])(
    "%s requires the auth variables",
    (APP_ENV) => {
      expect(() => defineEnv(fragments, { APP_ENV })).toThrowError(
        /BETTER_AUTH_SECRET \(missing\).*NEXT_PUBLIC_GOOGLE_CLIENT_ID \(missing\)/,
      );
    },
  );

  test("preview and production require the PostHog key", () => {
    for (const APP_ENV of ["preview", "production"]) {
      expect(() => defineEnv(fragments, { APP_ENV })).toThrowError(
        /NEXT_PUBLIC_POSTHOG_KEY \(missing\)/,
      );
      expect(() => defineEnv(fragments, { APP_ENV, NEXT_PUBLIC_POSTHOG_KEY: "" })).toThrowError(
        /NEXT_PUBLIC_POSTHOG_KEY \(missing\)/,
      );
    }
  });

  test("preview and production require the server PostHog token and host", () => {
    for (const APP_ENV of ["preview", "production"]) {
      expect(() =>
        defineEnv(fragments, { APP_ENV, NEXT_PUBLIC_POSTHOG_KEY: "phc_test" }),
      ).toThrowError(/POSTHOG_PROJECT_TOKEN \(missing\), POSTHOG_HOST \(missing\)/);
    }
  });

  test("the flags key is required in production only and must be a project secret key", () => {
    for (const APP_ENV of ["development", "preview"]) {
      expect(withKey(APP_ENV).POSTHOG_FEATURE_FLAGS_KEY).toBeUndefined();
    }
    expect(() => withKey("production")).toThrowError(/POSTHOG_FEATURE_FLAGS_KEY \(missing\)/);
    expect(() => withKey("production", { POSTHOG_FEATURE_FLAGS_KEY: "phc_1" })).toThrowError(
      /POSTHOG_FEATURE_FLAGS_KEY \(invalid\)/,
    );
  });

  test("GA and Clarity ids are accepted only in production", () => {
    const ids = { NEXT_PUBLIC_GA_ID: "G-TEST", NEXT_PUBLIC_CLARITY_ID: "abc123" };
    const flags = {
      POSTHOG_FEATURE_FLAGS_KEY: "phs_test",
      CRON_SECRET: "cron-secret-with-enough-length",
    };
    expect(
      withKey("production", { ...flags, ...brightdata, ...openaiControl, ...ids }),
    ).toMatchObject(ids);
    for (const APP_ENV of ["preview", "development"]) {
      expect(() => withKey(APP_ENV, ids)).toThrowError(
        /NEXT_PUBLIC_GA_ID \(forbidden\), NEXT_PUBLIC_CLARITY_ID \(forbidden\)/,
      );
    }
  });

  test("the cron secret is required in production only and too short a value is rejected", () => {
    expect(withKey("preview").CRON_SECRET).toBeUndefined();
    expect(() => withKey("production", { POSTHOG_FEATURE_FLAGS_KEY: "phs_1" })).toThrowError(
      /CRON_SECRET \(missing\)/,
    );
    expect(() => withKey("preview", { CRON_SECRET: "short" })).toThrowError(
      /CRON_SECRET \(invalid\)/,
    );
  });

  test("preview and production need the DataForSEO credentials to capture answers", () => {
    for (const APP_ENV of ["preview", "production"]) {
      expect(() => withoutDataforseo(APP_ENV)).toThrowError(
        /DATAFORSEO_LOGIN \(missing\), DATAFORSEO_PASSWORD \(missing\)/,
      );
    }
    expect(withoutDataforseo("development").DATAFORSEO_LOGIN).toBeUndefined();
  });

  test("production needs both Bright Data keys; previews never capture through it", () => {
    const flags = {
      POSTHOG_FEATURE_FLAGS_KEY: "phs_test",
      CRON_SECRET: "cron-secret-with-enough-length",
    };
    expect(() => withKey("production", flags)).toThrowError(
      /BRIGHTDATA_API_KEY \(missing\), BRIGHTDATA_BILLING_API_KEY \(missing\)/,
    );
    expect(withKey("production", { ...flags, ...brightdata, ...openaiControl })).toMatchObject(
      brightdata,
    );
    expect(withKey("preview").BRIGHTDATA_API_KEY).toBeUndefined();
  });

  test("production needs the OpenAI control key; previews never call the control channel", () => {
    const flags = {
      POSTHOG_FEATURE_FLAGS_KEY: "phs_test",
      CRON_SECRET: "cron-secret-with-enough-length",
    };
    expect(() => withKey("production", { ...flags, ...brightdata })).toThrowError(
      /OPENAI_CONTROL_API_KEY \(missing\)/,
    );
    expect(withKey("preview").OPENAI_CONTROL_API_KEY).toBeUndefined();
  });

  test("the PostHog region defaults to us and rejects unknown values", () => {
    expect(withKey("preview")).toMatchObject({ NEXT_PUBLIC_POSTHOG_REGION: "us" });
    expect(withKey("preview", { NEXT_PUBLIC_POSTHOG_REGION: "eu" })).toMatchObject({
      NEXT_PUBLIC_POSTHOG_REGION: "eu",
    });
    expect(() => withKey("preview", { NEXT_PUBLIC_POSTHOG_REGION: "asia" })).toThrowError(
      /NEXT_PUBLIC_POSTHOG_REGION \(invalid\)/,
    );
  });
});
