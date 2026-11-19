import { expect, test } from "vitest";
import { BlockHeaderUnavailableError, blockHeader, ESPLORA_APIS } from "../src/anchors/bitcoin";

// Block 358391, the one python-opentimestamps' hello-world.txt.ots is attested in.
const HEIGHT = 358_391;
const HASH = "000000000000000003e892881a8cdcdc117c06d444057c98b6f04a9ee75a2319";
const HEADER =
  "02000000b96394585a281b7e5f438fd1c9ed492645a1fd61cb3802040000000000000000007ee445d23ad061af4a36b809501fab1ac4f2d7e7a739817dd0cbb7ec661b8a1e376755f58616186272def6";

type Routes = Record<string, { status?: number; body: string } | Error>;

function explorers(routes: Routes) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const f = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    const route = routes[url];
    if (route instanceof Error) throw route;
    if (!route) return new Response("not found", { status: 404 });
    return new Response(route.body, { status: route.status ?? 200 });
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

test("an explorer that is down or not synced makes the lookup retry later", async () => {
  const down = explorers(
    agreeing({ [`${mempool}/block-height/${HEIGHT}`]: { status: 503, body: "" } }),
  );
  await expect(blockHeader(HEIGHT, { fetch: down })).rejects.toThrow(BlockHeaderUnavailableError);
  const unknown = explorers(
    agreeing({
      [`${blockstream}/block-height/${HEIGHT}`]: { status: 404, body: "Block not found" },
    }),
  );
  await expect(blockHeader(HEIGHT, { fetch: unknown })).rejects.toThrow("answered 404");
});
