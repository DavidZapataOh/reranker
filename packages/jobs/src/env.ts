import { config } from "@reranker/env";
import { z } from "@reranker/schema";

const usd = (description: string) =>
  config(
    z
      .string()
      .regex(/^\d+(\.\d{1,6})?$/, "must be a non-negative US dollar amount")
      .optional(),
    description,
  );

const count = (description: string) =>
  config(z.coerce.number().int().positive().optional(), description);

// Everything is optional: the defaults live in loadJobsConfig because they depend on APP_ENV.
export const jobsEnv = z.object({
  SPEND_CAP_DAILY_GLOBAL_USD: usd("Daily spend cap across every provider, in USD"),
  SPEND_CAP_DAILY_DATAFORSEO_USD: usd("Daily DataForSEO spend cap, in USD"),
  SPEND_CAP_DAILY_BRIGHTDATA_USD: usd("Daily Bright Data spend cap, in USD"),
  SPEND_CAP_DAILY_OPENAI_USD: usd("Daily OpenAI spend cap, in USD"),
  SPEND_CAP_DAILY_GEMINI_USD: usd("Daily Gemini API spend cap, in USD"),
  SPEND_CAP_DAILY_GOOGLE_PLACES_USD: usd("Daily Google Places spend cap, in USD"),
  SPEND_CAP_DAILY_ANTHROPIC_USD: usd("Daily Anthropic spend cap, in USD"),
  SPEND_CAP_DAILY_XAI_USD: usd("Daily xAI spend cap, in USD"),
  SPEND_CAP_DAILY_FREE_REPORT_USD: usd("Daily free report spend cap, in USD"),
  SPEND_CAP_DAILY_FREE_REPORT_ANONYMOUS_USD: usd("Free report pool for anonymous visitors, in USD"),
  SPEND_CAP_DAILY_FREE_REPORT_VERIFIED_USD: usd("Free report pool for verified visitors, in USD"),
  SPEND_CAP_DAILY_FREE_REPORT_ELSEWHERE_USD: usd(
    "Free report share for businesses outside the priority country, in USD",
  ),
  SPEND_CAP_DAILY_CONTROL_CANARY_USD: usd("Daily control canary spend cap, in USD"),
  SPEND_CAP_DAILY_QUALITY_CANARY_USD: usd("Daily quality canary spend cap, in USD"),
  SPEND_CAP_DAILY_BENCHMARK_USD: usd("Daily benchmark spend cap, in USD"),
  SPEND_CAP_DAILY_CONTRACT_TEST_USD: usd("Daily provider contract test spend cap, in USD"),
  WORKFLOWS_MONTHLY_BUDGET_USD: usd("Monthly Vercel Workflows budget, in USD"),
  QUOTA_RESEND_EMAILS_DAILY: count("Daily Resend email quota"),
  QUOTA_RESEND_EMAILS_SPLIT: config(
    z
      .string()
      .regex(/^\d+\/\d+\/\d+\/\d+$/, "must be critical/high/normal/low")
      .optional(),
    "Resend daily quota split as critical/high/normal/low",
  ),
  DATAFORSEO_MAX_IN_FLIGHT: count("DataForSEO concurrent requests"),
  DATAFORSEO_RPM: count("DataForSEO requests per minute"),
  BRIGHTDATA_MAX_IN_FLIGHT: count("Bright Data concurrent requests"),
  OPENAI_MAX_IN_FLIGHT: count("OpenAI concurrent requests"),
  OPENAI_RPM: count("OpenAI requests per minute of the project tier"),
  OPENAI_TPM: count("OpenAI tokens per minute of the project tier"),
  GEMINI_MAX_IN_FLIGHT: count("Gemini API concurrent requests"),
  GEMINI_RPM: count("Gemini API requests per minute of the project tier"),
  GEMINI_TPM: count("Gemini API tokens per minute of the project tier"),
  GOOGLE_PLACES_MAX_IN_FLIGHT: count("Google Places concurrent requests"),
  GOOGLE_PLACES_QPM: count("Google Places queries per minute"),
  JOBS_MAX_INLINE_WAIT_MS: count("Longest a step waits for provider capacity, in ms"),
  BREAKER_MIN_CALLS: count("Calls in the window before a breaker can open"),
  BREAKER_FAILURE_RATIO: config(
    z.coerce.number().gt(0).lte(1).optional(),
    "Failure ratio that opens a breaker",
  ),
  BREAKER_OPEN_MS: count("How long an open breaker stays open, in ms"),
});
