import { appEnv } from "@reranker/env";
import {
  InvalidInputError,
  MAX_PROBE_CALLS,
  type ProbeOptions,
  ProviderUnavailableError,
  probeSpendPath,
  RateLimitedError,
  SpendCapExceededError,
} from "@reranker/jobs";
import { hasCronBearer } from "../../../../lib/ops-guard";

// A thousand calls of three primitives run one after another.
export const maxDuration = 300;

const seconds = (ms: number) => String(Math.max(1, Math.ceil(ms / 1000)));
const empty = (status: number, retryAfterMs?: number) =>
  new Response(null, {
    status,
    headers: retryAfterMs === undefined ? {} : { "Retry-After": seconds(retryAfterMs) },
  });

async function readBody(req: Request): Promise<{ n?: unknown; holdMs?: unknown } | undefined> {
  const text = await req.text();
  if (text === "") return {};
  try {
    const body: unknown = JSON.parse(text);
    return typeof body === "object" && body !== null && !Array.isArray(body) ? body : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Measures the admission path of a provider call from where the functions run (iad1, next to
 * Neon us-east-1): `{ n?, holdMs? }` in, p50 and p95 per primitive out, nothing spent. It exists
 * only on previews, answers only to the cron bearer, and with `n: 1` and a hold it is the request
 * the capacity load test sends, so a denial answers the way a step would be told to retry.
 */
export async function POST(req: Request): Promise<Response> {
  if (appEnv() !== "preview") return empty(404);
  if (!hasCronBearer(req)) return empty(401);
  const body = await readBody(req);
  if (body === undefined) return empty(400);

  const opts: ProbeOptions = body.holdMs === undefined ? {} : { holdMs: body.holdMs as number };
  try {
    const report = await probeSpendPath((body.n ?? MAX_PROBE_CALLS) as number, opts);
    return Response.json(report, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof InvalidInputError) return empty(400);
    if (error instanceof RateLimitedError) return empty(429, error.retryAfterMs);
    if (error instanceof SpendCapExceededError) {
      return empty(429, error.resetsAt.getTime() - Date.now());
    }
    if (error instanceof ProviderUnavailableError) return empty(503, error.retryAfterMs);
    throw error;
  }
}
