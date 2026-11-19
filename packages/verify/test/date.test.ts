import { readFileSync } from "node:fs";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  blockstreamInfo,
  type HeaderCache,
  hasProofOfWork,
  mempoolSpace,
  sha256d,
} from "../src/bitcoin";
import { verifyOtsDate } from "../src/date";
import { mergeOtsTimestamps, parseDetachedOts, serializeDetachedOts } from "../src/format/index";

const fixture = (name: string) =>
  new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));
const HEADERS = JSON.parse(new TextDecoder().decode(fixture("bitcoin-headers.json"))) as Record<
  string,
  { hash: string; header: string }
>;
const block = (height: number) => HEADERS[height] as { hash: string; header: string };

// python-opentimestamps' hello-world.txt.ots, attested in block 358391.
const confirmedOts = fixture("ots/hello-world.txt.ots");
const pendingOts = fixture("ots/incomplete.txt.ots");
const { digest: checkpointDigest } = parseDetachedOts(confirmedOts);

const MEMPOOL = "https://mempool.space/api";
const BLOCKSTREAM = "https://blockstream.info/api";

type Reply = string | number | Error | "hang";
type Routes = Record<string, Reply>;

/** Both explorers serving the recorded blocks, with per-URL overrides. */
function explorers(overrides: Routes = {}) {
  const routes: Routes = {};
  for (const api of [MEMPOOL, BLOCKSTREAM]) {
    for (const [height, { hash, header }] of Object.entries(HEADERS)) {
      routes[`${api}/block-height/${height}`] = hash;
      routes[`${api}/block/${hash}/header`] = header;
    }
  }
  Object.assign(routes, overrides);
  const calls: string[] = [];
  const f = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    calls.push(url);
    const reply = routes[url];
    if (reply instanceof Error) throw reply;
    if (reply === "hang") {
      return new Promise<Response>((_, reject) =>
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason)),
      );
    }
    if (typeof reply === "number") return new Response("error", { status: reply });
    if (reply === undefined) return new Response("Block not found", { status: 404 });
    return new Response(reply, { headers: { "content-type": "text/plain" } });
  }) as typeof fetch;
  return Object.assign(f, { calls });
}

function memoryCache(entries: Record<number, Uint8Array> = {}) {
  const map = new Map(Object.entries(entries).map(([h, v]) => [Number(h), v]));
  return {
    map,
    get: (height: number) => map.get(height) ?? null,
    set: (height: number, header: Uint8Array) => void map.set(height, header),
  } satisfies HeaderCache & { map: Map<number, Uint8Array> };
}

const verify = (
  fetch: typeof globalThis.fetch,
  over: Partial<Parameters<typeof verifyOtsDate>[0]> = {},
) => verifyOtsDate({ checkpointDigest, ots: confirmedOts, fetch, cache: memoryCache(), ...over });

/** A detached proof over `digest` with a Bitcoin attestation on the digest itself. */
function attestedDirectly(height: number, digest = checkpointDigest) {
  return {
    msg: digest.slice(),
    attestations: [{ kind: "bitcoin" as const, height }],
    ops: [],
  };
}

// The easiest target the compact encoding allows (regtest's limit): about one hash in two meets it.
const EASIEST_BITS = 0x207fffff;

/**
 * Block 358391's header rewritten to commit to the checkpoint digest itself. With `bits`, it
 * claims that target and its nonce is ground until the header meets it.
 */
function forgedHeader(bits?: number): Uint8Array {
  const header = hexToBytes(block(358_391).header);
  header.set(checkpointDigest, 36);
  if (bits === undefined) return header;
  const view = new DataView(header.buffer);
  view.setUint32(72, bits, true);
  for (let nonce = 0; (sha256d(header)[31] as number) >= 0x7f; nonce++) {
    view.setUint32(76, nonce, true);
  }
  return header;
}

/** One explorer serving `header` as block `height`, under the hash it does have; the other down. */
function soleExplorer(height: number, header: Uint8Array) {
  const hash = bytesToHex(sha256d(header).reverse());
  return explorers({
    [`${MEMPOOL}/block-height/${height}`]: hash,
    [`${MEMPOOL}/block/${hash}/header`]: bytesToHex(header),
    [`${BLOCKSTREAM}/block-height/${height}`]: new TypeError("Failed to fetch"),
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

test("sha256d is double SHA-256, the hash Bitcoin names blocks by", () => {
  const header = hexToBytes(block(358_391).header);
  expect(sha256d(header)).toEqual(sha256(sha256(header)));
  expect(bytesToHex(sha256d(header).reverse())).toBe(block(358_391).hash);
});

describe("proof of work", () => {
  test.each(Object.keys(HEADERS).map(Number))("real block %i carries enough work", (height) => {
    expect(hasProofOfWork(hexToBytes(block(height).header), height)).toBe(true);
  });

  test("the floor follows the height: an old block's work is too little for a recent height", () => {
    expect(hasProofOfWork(hexToBytes(block(358_391).header), 975_744)).toBe(false);
  });

  test("heights before the first pinned era are refused", () => {
    expect(hasProofOfWork(hexToBytes(block(358_391).header), 349_999)).toBe(false);
  });

  test("a target with the compact sign bit set is refused", () => {
    const header = hexToBytes(block(358_391).header);
    new DataView(header.buffer).setUint32(72, 0x18800000, true);
    expect(hasProofOfWork(header, 358_391)).toBe(false);
  });
});

describe("confirmed proofs", () => {
  test("a commitment equal to header[36:68] passes with the block time as datedBefore", async () => {
    const f = explorers();
    expect(await verify(f)).toEqual({
      status: "pass",
      bitcoinHeight: 358_391,
      datedBefore: "2015-05-28T15:41:18.000Z",
      source: "mempool.space, blockstream.info",
    });
    expect(f.calls.every((u) => u.startsWith(MEMPOOL) || u.startsWith(BLOCKSTREAM))).toBe(true);
  });

  test("a header that does not hash to the block the explorer named fails", async () => {
    const { hash, header } = block(358_391);
    const forged = `${header.slice(0, 72)}${"00".repeat(32)}${header.slice(136)}`;
    const f = explorers({
      [`${MEMPOOL}/block/${hash}/header`]: forged,
      [`${BLOCKSTREAM}/block-height/358391`]: new TypeError("Failed to fetch"),
    });
    expect(await verify(f)).toEqual({ status: "fail", detail: "header_mismatch" });
  });

  test("a forged header from one explorer does not hide the other's valid one", async () => {
    const { hash, header } = block(358_391);
    const forged = `${header.slice(0, 72)}${"00".repeat(32)}${header.slice(136)}`;
    const f = explorers({ [`${MEMPOOL}/block/${hash}/header`]: forged });
    expect(await verify(f)).toMatchObject({ status: "pass", source: "blockstream.info" });
  });

  test.each([358_391, 975_744])(
    "a lone explorer cannot fabricate block %i: linkage without work fails",
    async (height) => {
      const ots = serializeDetachedOts(checkpointDigest, attestedDirectly(height));
      for (const header of [forgedHeader(), forgedHeader(EASIEST_BITS)]) {
        expect(await verify(soleExplorer(height, header), { ots })).toEqual({
          status: "fail",
          detail: "insufficient_work",
        });
      }
    },
  );

  test("a cached header without work is ignored", async () => {
    const cache = memoryCache({ 358391: forgedHeader(EASIEST_BITS) });
    expect(await verify(explorers(), { cache })).toMatchObject({ status: "pass" });
    expect(bytesToHex(cache.map.get(358_391) as Uint8Array)).toBe(block(358_391).header);
  });

  test("explorers naming different blocks confirm nothing", async () => {
    const other = block(358_390).hash;
    const f = explorers({ [`${MEMPOOL}/block-height/358391`]: other });
    expect(await verify(f)).toEqual({ status: "unavailable", detail: "explorers_disagree" });
  });

  test("a commitment that is not in the header fails", async () => {
    const ots = serializeDetachedOts(checkpointDigest, attestedDirectly(358_391));
    expect(await verify(explorers(), { ots })).toEqual({
      status: "fail",
      detail: "commitment_mismatch",
    });
  });

  test("the earliest attestation that holds dates the checkpoint", async () => {
    const { timestamp } = parseDetachedOts(confirmedOts);
    mergeOtsTimestamps(timestamp, attestedDirectly(358_390));
    const ots = serializeDetachedOts(checkpointDigest, timestamp);
    expect(await verify(explorers(), { ots })).toMatchObject({
      status: "pass",
      bitcoinHeight: 358_391,
    });
  });

  test("a proof over another digest fails without asking the explorers", async () => {
    const f = explorers();
    expect(await verify(f, { checkpointDigest: sha256(checkpointDigest) })).toEqual({
      status: "fail",
      detail: "digest_mismatch",
    });
    expect(f.calls).toEqual([]);
  });

  test("bytes that are not an OpenTimestamps proof fail", async () => {
    expect(await verify(explorers(), { ots: new Uint8Array([1, 2, 3]) })).toEqual({
      status: "fail",
      detail: "invalid_proof",
    });
  });
});

describe("explorer outages", () => {
  test("mempool.space down → blockstream.info alone dates it", async () => {
    const f = explorers({ [`${MEMPOOL}/block-height/358391`]: new TypeError("Failed to fetch") });
    expect(await verify(f)).toMatchObject({ status: "pass", source: "blockstream.info" });
  });

  test("an explorer slower than 3 s is dropped", async () => {
    vi.useFakeTimers();
    const f = explorers({ [`${MEMPOOL}/block-height/358391`]: "hang" });
    const result = verify(f);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(await result).toMatchObject({ status: "pass", source: "blockstream.info" });
  });

  test.each<[string, Reply]>([
    ["network errors", new TypeError("Failed to fetch")],
    ["server errors", 503],
    ["answers over 1 KB", "0".repeat(1025)],
    ["answers that are not a block hash", "<html>"],
  ])("both explorers with %s → unavailable, never pass", async (_, reply) => {
    const f = explorers({
      [`${MEMPOOL}/block-height/358391`]: reply,
      [`${BLOCKSTREAM}/block-height/358391`]: reply,
    });
    expect(await verify(f)).toEqual({ status: "unavailable", detail: "explorers_unavailable" });
  });

  test("a header that is not 80 bytes of hex counts as no answer", async () => {
    const { hash } = block(358_391);
    const f = explorers({
      [`${MEMPOOL}/block/${hash}/header`]: "zz",
      [`${BLOCKSTREAM}/block/${hash}/header`]: "00".repeat(81),
    });
    expect(await verify(f)).toEqual({ status: "unavailable", detail: "explorers_unavailable" });
  });

  test("an aborted verification asks nothing more and confirms nothing", async () => {
    const controller = new AbortController();
    controller.abort();
    const f = explorers();
    expect(await verify(f, { signal: controller.signal })).toEqual({
      status: "unavailable",
      detail: "explorers_unavailable",
    });
    expect(f.calls).toEqual([]);
  });
});

describe("unconfirmed proofs", () => {
  test("a pending-only proof is pending", async () => {
    const { digest } = parseDetachedOts(pendingOts);
    expect(await verify(explorers(), { checkpointDigest: digest, ots: pendingOts })).toEqual({
      status: "pending",
      detail: "not_confirmed",
    });
  });

  test("no proof yet is pending", async () => {
    expect(await verify(explorers(), { ots: null })).toEqual({
      status: "pending",
      detail: "no_proof",
    });
  });
});

describe("header cache", () => {
  test("a cached header avoids the network", async () => {
    const f = explorers();
    const cache = memoryCache({ 358391: hexToBytes(block(358_391).header) });
    expect(await verify(f, { cache })).toMatchObject({ status: "pass", bitcoinHeight: 358_391 });
    expect(f.calls).toEqual([]);
  });

  test("a verified header is cached, an unverified one is not", async () => {
    const cache = memoryCache();
    await verify(explorers(), { cache });
    expect(bytesToHex(cache.map.get(358_391) as Uint8Array)).toBe(block(358_391).header);

    const empty = memoryCache();
    await verify(explorers({ [`${MEMPOOL}/block-height/358391`]: block(358_390).hash }), {
      cache: empty,
    });
    expect(empty.map.size).toBe(0);
  });

  // A first visit reads the explorers; a second one, offline, is answered by the default cache.
  async function twoVisits() {
    const visit = (fetch: typeof globalThis.fetch) =>
      verifyOtsDate({ checkpointDigest, ots: confirmedOts, fetch });
    expect(await visit(explorers())).toMatchObject({ status: "pass" });
    const offline = explorers({
      [`${MEMPOOL}/block-height/358391`]: new TypeError("offline"),
      [`${BLOCKSTREAM}/block-height/358391`]: new TypeError("offline"),
    });
    expect(await visit(offline)).toMatchObject({ status: "pass" });
    expect(offline.calls).toEqual([]);
  }

  test("outside a browser the default cache lives in memory", twoVisits);

  test("browsers keep headers in localStorage across visits", async () => {
    const store = new Map<string, string>();
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
      },
    });
    await twoVisits();
    expect(store.get("rr-bh-358391")).toBe(block(358_391).header);
  });

  test("a corrupt or blocked localStorage falls back to the explorers", async () => {
    vi.stubGlobal("window", {
      localStorage: {
        getItem: () => "not a header",
        setItem: () => {
          throw new DOMException("quota", "QuotaExceededError");
        },
      },
    });
    const f = explorers();
    expect(await verifyOtsDate({ checkpointDigest, ots: confirmedOts, fetch: f })).toMatchObject({
      status: "pass",
    });
    expect(f.calls.length).toBeGreaterThan(0);

    vi.stubGlobal("window", {
      get localStorage(): never {
        throw new DOMException("denied", "SecurityError");
      },
    });
    expect(
      await verifyOtsDate({ checkpointDigest, ots: confirmedOts, fetch: explorers() }),
    ).toMatchObject({ status: "pass" });
  });
});

test("the default sources are mempool.space then blockstream.info", () => {
  expect([mempoolSpace.name, blockstreamInfo.name]).toEqual(["mempool.space", "blockstream.info"]);
});
