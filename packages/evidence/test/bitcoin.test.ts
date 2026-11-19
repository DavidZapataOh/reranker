import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { BlockHeaderUnavailableError, blockHeader, ESPLORA_APIS } from "../src/anchors/bitcoin";

// Block 358391, the one python-opentimestamps' hello-world.txt.ots is attested in.
const HEIGHT = 358_391;
const HASH = "000000000000000003e892881a8cdcdc117c06d444057c98b6f04a9ee75a2319";
const HEADER =
  "02000000b96394585a281b7e5f438fd1c9ed492645a1fd61cb3802040000000000000000007ee445d23ad061af4a36b809501fab1ac4f2d7e7a739817dd0cbb7ec661b8a1e376755f58616186272def6";

type Reply = { status?: number; body: string; headers?: Record<string, string> } | Error;
// A list replies in order and then repeats its last reply.
type Routes = Record<string, Reply | Reply[]>;

function explorers(routes: Routes) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const f = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    const replies = routes[url];
    const route = Array.isArray(replies)
      ? replies.length > 1
        ? replies.shift()
        : replies[0]
      : replies;
    if (route instanceof Error) throw route;
    if (!route) return new Response("not found", { status: 404 });
    return new Response(route.body, { status: route.status ?? 200, headers: route.headers ?? {} });
  }) as typeof fetch;
  return Object.assign(f, { calls });
}

const [blockstream, mempool] = ESPLORA_APIS;
const agreeing = (overrides: Routes = {}): Routes => ({
  [`${blockstream}/block-height/${HEIGHT}`]: { body: HASH },
  [`${mempool}/block-height/${HEIGHT}`]: { body: `${HASH}\n` },
  [`${blockstream}/block/${HASH}/header`]: { body: HEADER },
  ...overrides,
});

test("reads the merkle root and time of a header both explorers agree on", async () => {
  const f = explorers(agreeing());
  expect(await blockHeader(HEIGHT, { fetch: f })).toEqual({
    hash: HASH,
    // The commitment `ots info hello-world.txt.ots` prints for this block.
    merkleRoot: "8a1b66ecb7cbd07d8139a7e7d7f2c41aab1f5009b8364aaf61d03ad245e47e00",
    time: new Date("2015-05-28T15:41:18Z"),
  });
  for (const call of f.calls) expect(call.init.redirect).toBe("error");
});

test("explorers naming different blocks confirm nothing", async () => {
  const f = explorers(
    agreeing({ [`${mempool}/block-height/${HEIGHT}`]: { body: "0".repeat(64) } }),
  );
  await expect(blockHeader(HEIGHT, { fetch: f })).rejects.toThrow(BlockHeaderUnavailableError);
});

test("a header that does not hash to the agreed block is refused", async () => {
  const forged = `${HEADER.slice(0, 72)}${"00".repeat(32)}${HEADER.slice(136)}`;
  const f = explorers(agreeing({ [`${blockstream}/block/${HASH}/header`]: { body: forged } }));
  await expect(blockHeader(HEIGHT, { fetch: f })).rejects.toThrow("does not hash");
});

describe("transient explorer errors", () => {
  // setImmediate stays real so the explorer replies settle between pauses.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Settles the lookup, moving the fake clock only while it waits, and times it on that clock. */
  async function timed<T>(
    lookup: Promise<T>,
  ): Promise<{ outcome: PromiseSettledResult<T>; ms: number }> {
    const start = performance.now();
    let outcome: PromiseSettledResult<T> | undefined;
    void Promise.allSettled([lookup]).then(([settled]) => {
      outcome = settled;
    });
    while (!outcome) {
      await new Promise((resolve) => setImmediate(resolve));
      if (!outcome && vi.getTimerCount() > 0) vi.advanceTimersToNextTimer();
    }
    return { outcome, ms: performance.now() - start };
  }

  const connectTimeout = () =>
    new TypeError("fetch failed", {
      cause: Object.assign(new Error("connect"), { code: "UND_ERR_CONNECT_TIMEOUT" }),
    });

  test("an explorer that drops the connection or answers 503 for a moment is retried", async () => {
    const f = explorers(
      agreeing({
        [`${mempool}/block-height/${HEIGHT}`]: [connectTimeout(), connectTimeout(), { body: HASH }],
        [`${blockstream}/block/${HASH}/header`]: [{ status: 503, body: "" }, { body: HEADER }],
      }),
    );
    const { outcome } = await timed(blockHeader(HEIGHT, { fetch: f }));
    expect(outcome).toMatchObject({ status: "fulfilled", value: { hash: HASH } });
    expect(f.calls.filter((c) => c.url.startsWith(mempool))).toHaveLength(3);
  });

  test("a 429 waits out its Retry-After", async () => {
    const f = explorers(
      agreeing({
        [`${mempool}/block-height/${HEIGHT}`]: [
          { status: 429, body: "", headers: { "Retry-After": "3" } },
          { body: HASH },
        ],
      }),
    );
    const { outcome, ms } = await timed(blockHeader(HEIGHT, { fetch: f }));
    expect(outcome.status).toBe("fulfilled");
    expect(ms).toBeGreaterThanOrEqual(3_000);
  });

  test("an explorer that stays down or unreachable makes the lookup retry later, in time", async () => {
    for (const reply of [{ status: 503, body: "" }, connectTimeout()]) {
      const down = explorers(agreeing({ [`${mempool}/block-height/${HEIGHT}`]: reply }));
      const { outcome, ms } = await timed(blockHeader(HEIGHT, { fetch: down }));
      expect((outcome as PromiseRejectedResult).reason).toBeInstanceOf(BlockHeaderUnavailableError);
      expect(down.calls.filter((c) => c.url.startsWith(mempool)).length).toBeGreaterThan(2);
      expect(ms).toBeLessThanOrEqual(10_000);
    }
  });

  test("an explorer not synced to the block is not retried", async () => {
    const unknown = explorers(
      agreeing({
        [`${blockstream}/block-height/${HEIGHT}`]: { status: 404, body: "Block not found" },
      }),
    );
    const { outcome } = await timed(blockHeader(HEIGHT, { fetch: unknown }));
    expect((outcome as PromiseRejectedResult).reason.message).toMatch(/answered 404$/);
    expect(unknown.calls.filter((c) => c.url.startsWith(blockstream))).toHaveLength(1);
  });
});
