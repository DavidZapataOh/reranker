import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, concatBytes, hexToBytes } from "@noble/hashes/utils.js";

/** Reads the 80-byte header of the block at `height`; it must hash to the block the source named. */
export interface HeaderSource {
  name: string;
  header(height: number, signal: AbortSignal): Promise<Uint8Array>;
}

export interface HeaderCache {
  get(height: number): Uint8Array | null;
  set(height: number, header: Uint8Array): void;
}

export type HeaderLookup =
  | { status: "found"; header: Uint8Array; sources: string[] }
  | { status: "forged" | "disagree" | "unavailable" };

const SOURCE_TIMEOUT_MS = 3_000;
const MAX_RESPONSE_BYTES = 1_024;
const BLOCK_HASH = /^[0-9a-f]{64}$/;
const HEADER_HEX = /^[0-9a-f]{160}$/;

class ForgedHeaderError extends Error {
  override readonly name = "ForgedHeaderError";
}

export const sha256d = (bytes: Uint8Array): Uint8Array => sha256(sha256(bytes));

/** The block hash in the byte-reversed hex explorers print. */
const blockHash = (header: Uint8Array) => bytesToHex(sha256d(header).reverse());

// Explorer answers are a hash or a header; anything longer is cut off before it is buffered.
async function readText(fetchImpl: typeof fetch, url: string, signal: AbortSignal) {
  const response = await fetchImpl(url, { signal });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error(`${url} answered ${response.status}`);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error(`${url} answered more than ${MAX_RESPONSE_BYTES} bytes`);
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(concatBytes(...chunks)).trim();
}

/**
 * A block explorer running Esplora (API.md: `GET /block-height/:height` answers the block hash,
 * `GET /block/:hash/header` its header in hex). Both endpoints send `Access-Control-Allow-Origin: *`
 * and are simple requests, so browsers read them without a preflight.
 */
export function esplora(
  name: string,
  api: string,
  fetchImpl: typeof fetch = (input, init) => fetch(input, init),
): HeaderSource {
  return {
    name,
    async header(height, signal) {
      const hash = await readText(fetchImpl, `${api}/block-height/${height}`, signal);
      if (!BLOCK_HASH.test(hash)) throw new Error(`${name} named no block at ${height}`);
      const hex = await readText(fetchImpl, `${api}/block/${hash}/header`, signal);
      if (!HEADER_HEX.test(hex)) throw new Error(`${name} answered no header for ${hash}`);
      const header = hexToBytes(hex);
      if (blockHash(header) !== hash) {
        throw new ForgedHeaderError(`${name} served a header that does not hash to ${hash}`);
      }
      return header;
    },
  };
}

// Two operators, so neither can date a proof alone while the other answers differently.
export const mempoolSpace = esplora("mempool.space", "https://mempool.space/api");
export const blockstreamInfo = esplora("blockstream.info", "https://blockstream.info/api");

export const defaultHeaderSources = (fetchImpl?: typeof fetch): readonly HeaderSource[] =>
  fetchImpl
    ? [
        esplora(mempoolSpace.name, "https://mempool.space/api", fetchImpl),
        esplora(blockstreamInfo.name, "https://blockstream.info/api", fetchImpl),
      ]
    : [mempoolSpace, blockstreamInfo];

// AbortSignal.any and AbortSignal.timeout are missing from the older Safari versions still on phones.
function withTimeout(parent: AbortSignal | undefined, ms: number) {
  const controller = new AbortController();
  const abort = () => controller.abort(parent?.reason);
  parent?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error(`No answer within ${ms} ms`)), ms);
  return {
    signal: controller.signal,
    clear: () => {
      clearTimeout(timer);
      parent?.removeEventListener("abort", abort);
    },
  };
}

/**
 * The header of the block at `height`, from the cache or from every source at once: each source
 * gets 3 s, and the sources that answer must agree on the same header.
 */
export async function fetchHeader(
  height: number,
  sources: readonly HeaderSource[],
  opts: { cache: HeaderCache; signal?: AbortSignal | undefined },
): Promise<HeaderLookup> {
  const cached = opts.cache.get(height);
  if (cached) return { status: "found", header: cached, sources: [] };
  if (opts.signal?.aborted) return { status: "unavailable" };

  const answers = await Promise.allSettled(
    sources.map(async (source) => {
      const timeout = withTimeout(opts.signal, SOURCE_TIMEOUT_MS);
      try {
        return { name: source.name, header: await source.header(height, timeout.signal) };
      } finally {
        timeout.clear();
      }
    }),
  );
  const headers = answers.flatMap((a) => (a.status === "fulfilled" ? [a.value] : []));
  const [first] = headers;
  if (!first) {
    const forged = answers.some(
      (a) => a.status === "rejected" && a.reason instanceof ForgedHeaderError,
    );
    return { status: forged ? "forged" : "unavailable" };
  }
  const hash = blockHash(first.header);
  if (headers.some((h) => blockHash(h.header) !== hash)) return { status: "disagree" };
  opts.cache.set(height, first.header);
  return { status: "found", header: first.header, sources: headers.map((h) => h.name) };
}

type KeyValueStore = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

const memory = new Map<number, Uint8Array>();
const memoryCache: HeaderCache = {
  get: (height) => memory.get(height) ?? null,
  set: (height, header) => void memory.set(height, header),
};

function localStorageOf(): KeyValueStore | null {
  try {
    return (
      (globalThis as { window?: { localStorage?: KeyValueStore } }).window?.localStorage ?? null
    );
  } catch {
    // Browsers throw SecurityError when storage is blocked for the site.
    return null;
  }
}

/** Headers never change once buried, so a browser keeps them across visits in localStorage. */
export function defaultHeaderCache(): HeaderCache {
  const storage = localStorageOf();
  if (!storage) return memoryCache;
  const key = (height: number) => `rr-bh-${height}`;
  return {
    get(height) {
      try {
        const hex = storage.getItem(key(height));
        return hex && HEADER_HEX.test(hex) ? hexToBytes(hex) : null;
      } catch {
        return null;
      }
    },
    set(height, header) {
      try {
        storage.setItem(key(height), bytesToHex(header));
      } catch {
        // A full or blocked storage only costs a network read next time.
      }
    },
  };
}
