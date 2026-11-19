import type { LookupAddress } from "node:dns";
import { lookup } from "node:dns/promises";
import http, { type IncomingMessage } from "node:http";
import https, { type RequestOptions } from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { getDomain } from "tldts";

export interface SafeGetResult {
  status: number;
  body: string;
  finalUrl: string;
}

const MAX_REDIRECTS = 3;

// Everything that is not globally routable unicast (IANA special-purpose registries), so an owner's
// domain can never point the server at itself, its cloud metadata or a private network.
const NON_PUBLIC = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  NON_PUBLIC.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  // NAT64 and 6to4 addresses can carry any IPv4 address, private ones included. IPv4-mapped
  // addresses need no rule: BlockList checks them against the IPv4 subnets above.
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  NON_PUBLIC.addSubnet(network, prefix, "ipv6");
}

function isPublic({ address, family }: LookupAddress): boolean {
  return !NON_PUBLIC.check(address, family === 6 ? "ipv6" : "ipv4");
}

/** The host's addresses, only when every one is public: a mixed answer is a rebinding attempt. */
async function publicAddresses(hostname: string): Promise<LookupAddress[] | null> {
  const literal = isIP(hostname);
  const addresses = literal
    ? [{ address: hostname, family: literal }]
    : await lookup(hostname, { all: true }).catch(() => []);
  return addresses.length > 0 && addresses.every(isPublic) ? addresses : null;
}

// The connection uses the addresses already checked, so DNS cannot answer differently in between.
function pinnedLookup(addresses: LookupAddress[]): LookupFunction {
  return (_hostname, options, callback) => {
    const family = options.family === 4 || options.family === 6 ? options.family : 0;
    const usable = addresses.filter((a) => family === 0 || a.family === family);
    if (usable.length === 0) {
      callback(Object.assign(new Error("no checked address"), { code: "ENOTFOUND" }), "", 0);
    } else if (options.all) {
      (callback as (err: null, addresses: LookupAddress[]) => void)(null, usable);
    } else {
      const [first] = usable as [LookupAddress];
      callback(null, first.address, first.family);
    }
  };
}

function send(url: URL, options: RequestOptions): Promise<IncomingMessage> {
  const request = url.protocol === "https:" ? https.request : http.request;
  return new Promise((resolve, reject) => {
    const req = request(url, options, resolve);
    req.on("error", reject);
    req.end();
  });
}

function charsetOf(contentType: string | undefined): string {
  const charset = /charset=["']?([\w-]+)/i.exec(contentType ?? "")?.[1];
  try {
    return new TextDecoder(charset ?? "utf-8").encoding;
  } catch {
    return "utf-8";
  }
}

async function readUpTo(response: IncomingMessage, maxBytes: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of response as AsyncIterable<Buffer>) {
    chunks.push(chunk);
    size += chunk.length;
    if (size >= maxBytes) break;
  }
  response.destroy();
  const bytes = Buffer.concat(chunks).subarray(0, maxBytes);
  return new TextDecoder(charsetOf(response.headers["content-type"])).decode(bytes);
}

function sameSite(a: URL, b: URL): boolean {
  if (a.hostname === b.hostname) return true;
  const site = getDomain(a.hostname);
  return site !== null && site === getDomain(b.hostname);
}

/**
 * GET of a page an owner pointed us at: HTTPS only (plain HTTP only for the first request), public
 * addresses only, redirects only within the same site, and at most `maxBytes` of body.
 * Null on any refusal or failure.
 */
export async function safeGet(
  url: string,
  opts: { timeoutMs: number; maxBytes: number },
): Promise<SafeGetResult | null> {
  const signal = AbortSignal.timeout(opts.timeoutMs);
  let current: URL;
  try {
    current = new URL(url);
  } catch {
    return null;
  }
  const origin = current;
  if (current.protocol !== "https:" && current.protocol !== "http:") return null;

  try {
    for (let redirects = 0; ; redirects++) {
      if (current.username || current.password) return null;
      const addresses = await publicAddresses(current.hostname.replace(/^\[|\]$/g, ""));
      if (addresses === null || signal.aborted) return null;

      const response = await send(current, {
        method: "GET",
        lookup: pinnedLookup(addresses),
        signal,
        headers: { accept: "text/html,application/xhtml+xml" },
      });
      const status = response.statusCode ?? 0;
      const location = response.headers.location;
      if (status >= 300 && status < 400 && location) {
        response.destroy();
        const next = new URL(location, current);
        if (redirects >= MAX_REDIRECTS || next.protocol !== "https:" || !sameSite(origin, next)) {
          return null;
        }
        current = next;
        continue;
      }
      const body = await readUpTo(response, opts.maxBytes);
      return { status, body, finalUrl: current.href };
    }
  } catch {
    return null;
  }
}
