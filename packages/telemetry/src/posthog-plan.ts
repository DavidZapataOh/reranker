import { defineEnv } from "@reranker/env";
import { telemetryEnv } from "./env";

export type PostHogPlan = "free" | "pay-as-you-go";

export type PostHogLimits = {
  /** Monthly allowances past which PostHog drops data; null when usage is billed instead. */
  events: number | null;
  exceptions: number | null;
  /** Insight alerts the whole organization may hold. */
  alerts: number;
};

// https://posthog.com/pricing and https://posthog.com/docs/alerts (read 2026-11-17): Free drops
// what passes its allowances and holds 5 alerts; with a card the same usage is billed instead and
// alerts have no limit.
const LIMITS: Readonly<Record<PostHogPlan, PostHogLimits>> = {
  free: { events: 1_000_000, exceptions: 100_000, alerts: 5 },
  "pay-as-you-go": { events: null, exceptions: null, alerts: Number.POSITIVE_INFINITY },
};

const env = telemetryEnv.pick({ POSTHOG_PLAN: true });

/** The organization's plan as configured; the launch gate checks it against PostHog billing. */
export function postHogPlan(): PostHogPlan {
  return defineEnv([env]).POSTHOG_PLAN;
}

export function postHogLimits(plan: PostHogPlan = postHogPlan()): PostHogLimits {
  return LIMITS[plan];
}
