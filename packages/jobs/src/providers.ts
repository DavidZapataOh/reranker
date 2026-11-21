import type { CaptureProvider } from "@reranker/schema";

// Anthropic and xAI only annotate benchmark labels; the rest are the capture providers.
export type PaidProvider = CaptureProvider | "gemini" | "google_places" | "anthropic" | "xai";

export type SpendPurpose =
  | "free-report"
  | "control-canary"
  | "quality-canary"
  | "benchmark"
  | "contract-test"
  | "language-mix";

/** Child scopes of `purpose:free-report` that a reservation chooses between. */
export type SpendPool = "free-report-anonymous" | "free-report-verified";

/** A child scope of `purpose:free-report` that a reservation joins by its country, never by choice. */
export type SpendRegionPool = "free-report-elsewhere";

export type JobPriority = "critical" | "high" | "normal" | "low";

export interface ProviderLimits {
  maxInFlight: number;
  rpm?: number;
  tpm?: number;
  account?: string;
}
