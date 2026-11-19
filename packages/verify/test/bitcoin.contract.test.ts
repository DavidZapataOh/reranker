import { readFileSync } from "node:fs";
import { bytesToHex } from "@noble/hashes/utils.js";
import { expect, test } from "vitest";
import { blockstreamInfo, mempoolSpace, sha256d } from "../src/bitcoin";
import { verifyOtsDate } from "../src/date";
import { parseDetachedOts } from "../src/format/index";

// Block 358391, the one python-opentimestamps' hello-world.txt.ots is attested in.
const HEIGHT = 358_391;
const HASH = "000000000000000003e892881a8cdcdc117c06d444057c98b6f04a9ee75a2319";

test("both live explorers serve the same header, and it hashes to the block", async () => {
  const signal = AbortSignal.timeout(10_000);
  const [a, b] = await Promise.all([
    mempoolSpace.header(HEIGHT, signal),
    blockstreamInfo.header(HEIGHT, signal),
  ]);
  expect(bytesToHex(a)).toBe(bytesToHex(b));
  expect(bytesToHex(sha256d(a).reverse())).toBe(HASH);
});

test("the hello-world proof is dated by the live explorers", async () => {
  const ots = new Uint8Array(
    readFileSync(new URL("./fixtures/ots/hello-world.txt.ots", import.meta.url)),
  );
  const result = await verifyOtsDate({
    checkpointDigest: parseDetachedOts(ots).digest,
    ots,
    cache: { get: () => null, set: () => {} },
  });
  expect(result).toEqual({
    status: "pass",
    bitcoinHeight: HEIGHT,
    datedBefore: "2015-05-28T15:41:18.000Z",
    source: "mempool.space, blockstream.info",
  });
});
