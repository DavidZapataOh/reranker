import { readFileSync } from "node:fs";
import { resetAppEnv } from "@reranker/env";
import { requireEnv } from "@reranker/testing/env";
import { afterAll, expect, test, vi } from "vitest";
import { getFlagsClient, resetFlagsClient } from "./client";
import { isEnabled } from "./evaluate";
import { createPostHogApi } from "./posthog-api";
import { registry } from "./registry";
import { checkFlags } from "./sync";

afterAll(resetFlagsClient);

test("PostHog holds every registry flag", async () => {
  const api = createPostHogApi(requireEnv("POSTHOG_READONLY_API_KEY"));
  const genFile = readFileSync(new URL("./flag-keys.gen.ts", import.meta.url), "utf8");
  expect(checkFlags(registry, await api.listFlags(), genFile)).toEqual([]);
});

test("the project secret key loads the definitions and a new flag reads off", async () => {
  vi.stubEnv("APP_ENV", "production");
  vi.stubEnv("POSTHOG_FEATURE_FLAGS_KEY", requireEnv("POSTHOG_FEATURE_FLAGS_KEY"));
  vi.stubEnv("POSTHOG_PROJECT_TOKEN", requireEnv("POSTHOG_PROJECT_TOKEN"));
  vi.stubEnv("POSTHOG_HOST", "https://us.i.posthog.com");
  resetAppEnv();
  expect(await getFlagsClient().waitForLocalEvaluationReady(10_000)).toBe(true);
  expect(await isEnabled("accounts", { kind: "house" })).toBe(false);
});
