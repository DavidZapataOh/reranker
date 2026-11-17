import { defineEnv } from "@reranker/env";
import { assertCaptureAllowed } from "@reranker/flags";
import { z } from "@reranker/schema";
import { digestEnv } from "@reranker/telemetry/env";
import { opsGuard } from "../../../../../lib/ops-guard";

// The longest probe (280 s) plus headroom for the last provider call.
export const maxDuration = 300;

const TICK_MS = 5_000;
const PROVIDER_TIMEOUT_MS = 3_000;
const DEFAULT_SECONDS = 120;
// Free to call and the sandbox never bills: https://docs.dataforseo.com/v3/appendix/user_data/
const USER_DATA = "https://sandbox.dataforseo.com/v3/appendix/user_data";

const Seconds = z.coerce.number().int().min(1).max(280);

const credentials = z.object({
  DATAFORSEO_LOGIN: digestEnv.shape.DATAFORSEO_LOGIN,
  DATAFORSEO_PASSWORD: digestEnv.shape.DATAFORSEO_PASSWORD,
});

const CAPTURE = { channel: "ui-vendor", provider: "dataforseo", engine: "chatgpt" } as const;

// Any failure counts as blocked: a probe that reported "allowed" on an unknown state would
// hide exactly the gap it is meant to measure.
async function captureAllowed(): Promise<boolean> {
  try {
    await assertCaptureAllowed(CAPTURE);
    return true;
  } catch {
    return false;
  }
}

async function callProvider(authorization: string | undefined, signal: AbortSignal) {
  try {
    const response = await fetch(USER_DATA, {
      headers: authorization ? { Authorization: authorization } : {},
      signal: AbortSignal.any([signal, AbortSignal.timeout(PROVIDER_TIMEOUT_MS)]),
    });
    await response.body?.cancel();
  } catch {
    // Only whether the call left matters, not how the provider answered.
  }
}

function basicAuth(): string | undefined {
  const env = defineEnv([credentials]);
  if (!env.DATAFORSEO_LOGIN || !env.DATAFORSEO_PASSWORD) return undefined;
  const token = Buffer.from(`${env.DATAFORSEO_LOGIN}:${env.DATAFORSEO_PASSWORD}`);
  return `Basic ${token.toString("base64")}`;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

/**
 * Measures how long a kill switch takes to reach a running capture: every five seconds it asks
 * the capture gate and, when allowed, makes a free DataForSEO sandbox call, streaming one NDJSON
 * line `{ t, allowed, providerCalled }` per tick until `seconds` (1..280, default 120) elapse.
 */
export async function GET(req: Request): Promise<Response> {
  const denied = opsGuard(req);
  if (denied) return denied;

  const raw = new URL(req.url).searchParams.get("seconds");
  const parsed = Seconds.safeParse(raw ?? DEFAULT_SECONDS);
  if (!parsed.success) {
    return Response.json({ error: "seconds must be an integer from 1 to 280" }, { status: 400 });
  }

  const ticks = Math.ceil((parsed.data * 1000) / TICK_MS);
  const authorization = basicAuth();
  const stop = new AbortController();
  const signal = AbortSignal.any([req.signal, stop.signal]);
  const encoder = new TextEncoder();

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const startedAt = Date.now();
      for (let i = 0; i < ticks && !signal.aborted; i++) {
        await sleep(startedAt + i * TICK_MS - Date.now(), signal);
        if (signal.aborted) break;
        const t = new Date().toISOString();
        const allowed = await captureAllowed();
        if (allowed) await callProvider(authorization, signal);
        if (signal.aborted) break;
        controller.enqueue(
          encoder.encode(`${JSON.stringify({ t, allowed, providerCalled: allowed })}\n`),
        );
      }
      // A cancelled stream rejects close(); its reader is already gone.
      if (!stop.signal.aborted) controller.close();
    },
    cancel() {
      stop.abort();
    },
  });

  return new Response(body, {
    headers: { "content-type": "application/x-ndjson", "cache-control": "no-store" },
  });
}
