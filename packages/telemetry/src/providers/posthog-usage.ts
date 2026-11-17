import { defineEnv } from "@reranker/env";
import { z } from "@reranker/schema";
import { telemetryEnv } from "../env";
import { createPostHogRest, PostHogApiError } from "../posthog-rest";
import { SourceError } from "./source-error";

// https://posthog.com/docs/api/queries
const USAGE = `SELECT countIf(event != '$exception'), countIf(event = '$exception')
FROM events
WHERE timestamp >= toStartOfMonth(now())`;

const key = z.object({ POSTHOG_QUERY_READ_KEY: telemetryEnv.shape.POSTHOG_QUERY_READ_KEY });
const Result = z.object({ results: z.tuple([z.tuple([z.number(), z.number()])]) });

/** Events and exceptions ingested this month, the two PostHog allowances that can run out. */
export async function posthogUsage(
  signal?: AbortSignal,
): Promise<{ events: number; exceptions: number }> {
  const env = defineEnv([key]);
  if (!env.POSTHOG_QUERY_READ_KEY) throw new SourceError("falta POSTHOG_QUERY_READ_KEY");
  const body = { query: { kind: "HogQLQuery", query: USAGE }, name: "ops daily digest usage" };
  try {
    const raw = await createPostHogRest(env.POSTHOG_QUERY_READ_KEY).send(
      "query/",
      "POST",
      body,
      signal,
    );
    const [[events, exceptions]] = Result.parse(raw).results;
    return { events, exceptions };
  } catch (error) {
    if (error instanceof PostHogApiError) throw new SourceError(`respuesta HTTP ${error.status}`);
    throw error;
  }
}
