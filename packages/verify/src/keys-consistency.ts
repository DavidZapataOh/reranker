import type { Check } from "./dsse";
import { TRUSTED_KEYS, type TrustedKey } from "./trust/keys";

const JWKS_URL = "https://reranker.co/.well-known/jwks.json";
const TXT_NAME = "_rr-keys.reranker.co";
const TXT_TYPE = 16;
// Both lookups run in parallel, so this bounds the whole check.
const TIMEOUT_MS = 2_000;

// Google's JSON API joins a record's character-strings; Cloudflare's returns them in RFC 1035
// presentation format, each one quoted.
const RESOLVERS = [
  { url: `https://dns.google/resolve?name=${TXT_NAME}&type=TXT`, quoted: false },
  { url: `https://cloudflare-dns.com/dns-query?name=${TXT_NAME}&type=TXT`, quoted: true },
] as const;

type Place = "match" | "mismatch" | "unavailable";

interface Lookup {
  fetch: typeof fetch;
  signal: AbortSignal;
}

async function getJson(
  url: string,
  init: RequestInit,
  { fetch, signal }: Lookup,
): Promise<unknown> {
  try {
    const response = await fetch(url, { ...init, signal });
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}

const toBase64Url = (base64: string) =>
  base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function jwksPlace(key: TrustedKey, lookup: Lookup): Promise<Place> {
  const body = await getJson(JWKS_URL, {}, lookup);
  const keys = (body as { keys?: unknown } | null)?.keys;
  if (!Array.isArray(keys)) return "unavailable";
  const jwk = keys.find((k) => k?.kid === key.keyid);
  // RFC 8037: an Ed25519 public key travels as unpadded base64url in `x`.
  const same = jwk?.kty === "OKP" && jwk.crv === "Ed25519" && jwk.x === toBase64Url(key.publicKey);
  return same ? "match" : "mismatch";
}

/** Joins the quoted character-strings of an RFC 1035 §5.1 TXT value, decoding `\X` and `\DDD`. */
function unquote(data: string): string {
  let text = "";
  for (const [, chunk] of data.matchAll(/"((?:[^"\\]|\\.)*)"/g)) {
    text += chunk?.replace(/\\(\d{3}|.)/g, (_, escaped: string) =>
      escaped.length === 3 ? String.fromCharCode(Number(escaped)) : escaped,
    );
  }
  return text;
}

async function txtPlace(
  key: TrustedKey,
  resolver: (typeof RESOLVERS)[number],
  lookup: Lookup,
): Promise<Place> {
  const init = resolver.quoted ? { headers: { accept: "application/dns-json" } } : {};
  const body = (await getJson(resolver.url, init, lookup)) as {
    Status?: number;
    Answer?: Array<{ type?: number; data?: unknown }>;
  } | null;
  // NOERROR and NXDOMAIN are answers; anything else (SERVFAIL, REFUSED…) says nothing about us.
  if (body?.Status !== 0 && body?.Status !== 3) return "unavailable";
  const prefix = `${key.keyid}=`;
  const values = (body.Answer ?? [])
    .filter((answer) => answer.type === TXT_TYPE && typeof answer.data === "string")
    .map((answer) => (resolver.quoted ? unquote(answer.data as string) : (answer.data as string)))
    .filter((text) => text.startsWith(prefix))
    .map((text) => text.slice(prefix.length));
  return values.length > 0 && values.every((v) => v === key.publicKey) ? "match" : "mismatch";
}

/** The TXT place counts when at least one resolver answers and every one that answers agrees. */
function combine(places: Place[]): Place {
  if (places.includes("mismatch")) return "mismatch";
  return places.includes("match") ? "match" : "unavailable";
}

/**
 * Compares the pinned public key with the two copies the operator publishes elsewhere: the JWKS on
 * reranker.co and the `_rr-keys` TXT record read over DNS-over-HTTPS from two resolvers. Swapping
 * a key would then require tampering with the bundle, the web origin and DNS at once.
 */
export async function checkKeyConsistency(
  keyid: string,
  opts: { fetch?: typeof fetch; signal?: AbortSignal } = {},
): Promise<Check & { matches: number; of: 3 }> {
  const key = TRUSTED_KEYS.find((k) => k.keyid === keyid);
  if (!key) return { status: "fail", detail: "unknown_key", matches: 0, of: 3 };

  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const lookup: Lookup = {
    fetch: opts.fetch ?? globalThis.fetch,
    signal: opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout,
  };
  const [jwks, ...txt] = await Promise.all([
    jwksPlace(key, lookup),
    ...RESOLVERS.map((resolver) => txtPlace(key, resolver, lookup)),
  ]);
  const places = [jwks, combine(txt)];

  const matches = 1 + places.filter((p) => p === "match").length;
  if (places.includes("mismatch"))
    return { status: "fail", detail: "doh_mismatch", matches, of: 3 };
  if (places.includes("unavailable")) return { status: "unavailable", matches, of: 3 };
  return { status: "pass", matches, of: 3 };
}

function instant(iso: string): number | null {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Whether a signature by `key` can be trusted given when it was first anchored in time (`null`
 * when it is not anchored yet). Once a key is compromised, anyone may have signed with it, so only
 * signatures provably older than the compromise are kept. A retired key was disabled, not leaked:
 * an unanchored signature is still its own, but one anchored after retirement is not.
 */
export function acceptsKeyAt(key: TrustedKey, anchoredAt: string | null): boolean {
  const validFrom = instant(key.validFrom);
  const validTo = key.validTo === null ? null : instant(key.validTo);
  const compromisedAfter = key.compromisedAfter === null ? null : instant(key.compromisedAfter);
  if (validFrom === null) return false;
  if (key.validTo !== null && validTo === null) return false;
  if (key.compromisedAfter !== null && compromisedAfter === null) return false;

  const anchored = anchoredAt === null ? null : instant(anchoredAt);
  if (anchored === null) return compromisedAfter === null;
  if (anchored < validFrom) return false;
  if (validTo !== null && anchored > validTo) return false;
  return compromisedAfter === null || anchored <= compromisedAfter;
}
