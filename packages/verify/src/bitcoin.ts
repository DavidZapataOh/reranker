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
  | { status: "forged" | "no_work" | "disagree" | "unavailable" };

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

/**
 * The easiest target any block in each era of 50,000 heights carried, read from the
 * difficulty adjustments mempool.space lists (`/api/v1/mining/difficulty-adjustments/all`) up to
 * block 976642 on 2026-11-19. Rows are `[first height, nBits of the easiest retarget]`.
 */
const WORK_FLOOR: ReadonlyArray<readonly [number, number]> = [
  [350_000, 0x181788f2], // block 348768
  [400_000, 0x1806f0a8], // block 401184
  [450_000, 0x1802cc47], // block 449568
  [500_000, 0x18009645], // block 499968
  [550_000, 0x17371ef4], // block 554400
  [600_000, 0x171620d1], // block 602784
  [650_000, 0x17149624], // block 691488
  [700_000, 0x170f48e4], // block 699552
  [750_000, 0x1709ed88], // block 749952
  [800_000, 0x17056102], // block 800352
  [850_000, 0x17038a6d], // block 850752
  [900_000, 0x17026816], // block 903168
  [950_000, 0x170240c3], // block 953568
];
const FLOOR_MEASURED_THROUGH = 976_642;
// Consensus lets difficulty fall at most 4× per retarget; past the measured height the floor
// allows one such fall, so only a lasting collapse of three quarters of the hash rate trips it.
const UNMEASURED_MARGIN = 4n;

/** The target a compact nBits encodes, or null for a negative or zero one (Bitcoin's SetCompact). */
function targetFromBits(bits: number): bigint | null {
  const exponent = bits >>> 24;
  const mantissa = bits & 0x007fffff;
  if (bits & 0x00800000 || mantissa === 0) return null;
  return exponent <= 3
    ? BigInt(mantissa >>> (8 * (3 - exponent)))
    : BigInt(mantissa) << BigInt(8 * (exponent - 3));
}

/**
 * Whether the header's double SHA-256, read as a little-endian number, meets the target in its
 * nBits, and that target is no easier than any real block of that era carried. Hash linkage alone
 * proves nothing when one explorer answers: it can make up a header and its hash together, but not
 * the work, which at these floors costs more than any proof is worth.
 */
export function hasProofOfWork(header: Uint8Array, height: number): boolean {
  const era = WORK_FLOOR.findLast(([from]) => from <= height);
  if (!era || header.length !== 80) return false;
  const floor = targetFromBits(era[1]) as bigint;
  const target = targetFromBits(
    new DataView(header.buffer, header.byteOffset, header.length).getUint32(72, true),
  );
  const limit = height > FLOOR_MEASURED_THROUGH ? floor * UNMEASURED_MARGIN : floor;
  return target !== null && target <= limit && BigInt(`0x${blockHash(header)}`) <= target;
}

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
  if (cached && hasProofOfWork(cached, height)) {
    return { status: "found", header: cached, sources: [] };
  }
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
  const linked = answers.flatMap((a) => (a.status === "fulfilled" ? [a.value] : []));
  const headers = linked.filter((h) => hasProofOfWork(h.header, height));
  const [first] = headers;
  if (!first) {
    if (linked.length > 0) return { status: "no_work" };
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
