import type { RawSink } from "./raw-sink";

// The DOM `RequestInfo` alias is not in the Node lib; this is the same input fetch accepts.
export type FetchInput = Parameters<typeof fetch>[0];
export type Fetch = (url: FetchInput, init?: RequestInit) => Promise<Response>;

// DataForSEO answers Live calls in up to 120 s; aborting a little earlier leaves the step time to
// seal what arrived.
const DEFAULT_TIMEOUT_MS = 115_000;

async function requestBody(url: FetchInput, init?: RequestInit): Promise<Uint8Array | null> {
  const body = init?.body ?? null;
  if (body === null) {
    return url instanceof Request && url.body
      ? new Uint8Array(await url.clone().arrayBuffer())
      : null;
  }
  if (typeof body === "string") return new TextEncoder().encode(body);
  if (body instanceof ArrayBuffer) return new Uint8Array(body.slice(0));
  if (ArrayBuffer.isView(body)) {
    return new Uint8Array(body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength));
  }
  // A body this tee cannot copy byte for byte would leave the evidence without its request.
  throw new TypeError("recordingFetch only records string and binary request bodies");
}

/**
 * A provider-agnostic fetch that keeps the exact request and response bytes in `sink` and hands
 * the caller the untouched response.
 */
export function recordingFetch(
  sink: RawSink,
  opts: { timeoutMs?: number; headers?: Record<string, string> } = {},
): Fetch {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return async (url, init) => {
    sink.recordRequest(await requestBody(url, init));
    const headers = new Headers(init?.headers);
    for (const [name, value] of Object.entries(opts.headers ?? {})) headers.set(name, value);
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    const response = await fetch(url, { ...init, headers, signal });
    sink.recordResponseHead(response);
    sink.recordResponseBody(new Uint8Array(await response.clone().arrayBuffer()));
    return response;
  };
}

/** `recordingFetch` with DataForSEO's Basic authentication, as the official client README sets it. */
export function teeFetch(
  auth: { login: string; password: string },
  sink: RawSink,
  opts: { timeoutMs?: number } = {},
): Fetch {
  const token = Buffer.from(`${auth.login}:${auth.password}`).toString("base64");
  return recordingFetch(sink, { ...opts, headers: { Authorization: `Basic ${token}` } });
}
