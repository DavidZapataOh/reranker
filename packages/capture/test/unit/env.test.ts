import { defineEnv } from "@reranker/env";
import { describe, expect, test } from "vitest";
import { brightdataEnv } from "../../src/brightdata/env";
import { captureEnv } from "../../src/env";
import { openaiControlEnv } from "../../src/openai/env";

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

describe("Bright Data", () => {
  const keys = { BRIGHTDATA_API_KEY: "user-key", BRIGHTDATA_BILLING_API_KEY: "finance-key" };

  test("production fails without either key", () => {
    expect(() => defineEnv([brightdataEnv], { APP_ENV: "production" })).toThrowError(
      /BRIGHTDATA_API_KEY \(missing\), BRIGHTDATA_BILLING_API_KEY \(missing\)/,
    );
  });

  test.each(["preview", "development"])("%s runs without the keys", (APP_ENV) => {
    expect(defineEnv([brightdataEnv], { APP_ENV }).BRIGHTDATA_API_KEY).toBeUndefined();
  });

  test("the dataset ids default to Bright Data's published scrapers and can be overridden", () => {
    expect(defineEnv([brightdataEnv], { APP_ENV: "production", ...keys })).toMatchObject({
      BRIGHTDATA_PERPLEXITY_DATASET_ID: "gd_m7dhdot1vw9a7gc1n",
      BRIGHTDATA_CHATGPT_DATASET_ID: "gd_m7aof0k82r803d5bjm",
    });
    const env = defineEnv([brightdataEnv], {
      APP_ENV: "production",
      ...keys,
      BRIGHTDATA_CHATGPT_DATASET_ID: "gd_abc123",
    });
    expect(env.BRIGHTDATA_CHATGPT_DATASET_ID).toBe("gd_abc123");
  });

  test("a dataset id that is not one is rejected", () => {
    expect(() =>
      defineEnv([brightdataEnv], { APP_ENV: "development", BRIGHTDATA_PERPLEXITY_DATASET_ID: "x" }),
    ).toThrowError(/BRIGHTDATA_PERPLEXITY_DATASET_ID \(invalid\)/);
  });
});

describe("OpenAI control channel", () => {
  test("production fails without its key", () => {
    expect(() => defineEnv([openaiControlEnv], { APP_ENV: "production" })).toThrowError(
      /OPENAI_CONTROL_API_KEY \(missing\)/,
    );
  });

  test.each(["preview", "development"])("%s runs without the key", (APP_ENV) => {
    expect(defineEnv([openaiControlEnv], { APP_ENV }).OPENAI_CONTROL_API_KEY).toBeUndefined();
  });

  test("a value that is not an OpenAI key is rejected", () => {
    expect(() =>
      defineEnv([openaiControlEnv], { APP_ENV: "production", OPENAI_CONTROL_API_KEY: "key" }),
    ).toThrowError(/OPENAI_CONTROL_API_KEY \(invalid\)/);
  });
});
