import { appEnv } from "@reranker/env";
import {
  DEFAULT_SEAL_PROBES,
  EvidenceStorageUnavailableError,
  probeSealCapture,
  SigningUnavailableError,
} from "@reranker/evidence";
import {
  InvalidInputError,
  MAX_PROBE_CALLS,
  type ProbeOptions,
  ProviderUnavailableError,
  probeNetworkLookup,
  probeSpendPath,
  RateLimitedError,
  SpendCapExceededError,
} from "@reranker/jobs";
import { isAppError } from "@reranker/schema";
import { hasCronBearer } from "../../../../lib/ops-guard";

// A thousand calls of three primitives run one after another.
export const maxDuration = 300;

const seconds = (ms: number) => String(Math.max(1, Math.ceil(ms / 1000)));
const empty = (status: number, retryAfterMs?: number) =>
  new Response(null, {
    status,
    headers: retryAfterMs === undefined ? {} : { "Retry-After": seconds(retryAfterMs) },
  });

type Body = { probe?: unknown; n?: unknown; holdMs?: unknown };

async function readBody(req: Request): Promise<Body | undefined> {
  const text = await req.text();
  if (text === "") return {};
  try {
    const body: unknown = JSON.parse(text);
    return typeof body === "object" && body !== null && !Array.isArray(body) ? body : undefined;
  } catch {
    return undefined;
  }
}

function run(body: Body) {
  if (body.probe === "seal") {
    if (body.holdMs !== undefined) throw new InvalidInputError("A seal probe holds nothing");
    return probeSealCapture((body.n ?? DEFAULT_SEAL_PROBES) as number);
  }
  const n = (body.n ?? MAX_PROBE_CALLS) as number;
  if (body.probe === "network") {
    if (body.holdMs !== undefined) throw new InvalidInputError("A network probe holds nothing");
    return probeNetworkLookup(n);
  }
  if (body.probe !== undefined && body.probe !== "spend") {
    throw new InvalidInputError("Probe is spend, network or seal");
  }
  const opts: ProbeOptions = body.holdMs === undefined ? {} : { holdMs: body.holdMs as number };
  return probeSpendPath(n, opts);
}

/**
 * Measures primitives from where the functions run (iad1, next to Neon us-east-1): `{ probe?,
 * n?, holdMs? }` in, p50 and p95 per primitive out, nothing spent. The default `spend` probe times
 * the admission path of a provider call; `network` times the datacenter and VPN lookup; `seal`
 * times capture sealing against the preview's R2 buckets and KMS key, deleting all it writes. It exists
 * only on previews, answers only to the cron bearer, and with `n: 1` and a hold it is the request
 * the capacity load test sends, so a denial answers the way a step would be told to retry.
 */
export async function POST(req: Request): Promise<Response> {
  if (appEnv() !== "preview") return empty(404);
  if (!hasCronBearer(req)) return empty(401);
  const body = await readBody(req);
  if (body === undefined) return empty(400);

  try {
    const report = await run(body);
    return Response.json(report, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof InvalidInputError) return empty(400);
    if (error instanceof RateLimitedError) return empty(429, error.retryAfterMs);
    if (error instanceof SpendCapExceededError) {
      return empty(429, error.resetsAt.getTime() - Date.now());
    }
    if (error instanceof ProviderUnavailableError) return empty(503, error.retryAfterMs);
    if (
      error instanceof EvidenceStorageUnavailableError ||
      error instanceof SigningUnavailableError
    ) {
      return empty(503);
    }
    // A step retries these after the wait they carry, so the probe answers that wait too.
    if (isAppError(error) && error.retryAfterSeconds !== undefined) {
      return empty(error.status, error.retryAfterSeconds * 1000);
    }
    throw error;
  }
}
