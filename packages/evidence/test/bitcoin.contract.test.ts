import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { blockHeader } from "../src/anchors/bitcoin";

// The live explorers must agree on the block python-opentimestamps' hello-world proof is attested
// in, and its header must carry the commitment `ots info` prints for it.
test("both explorers confirm the hello-world attestation", async () => {
  const [expected] = JSON.parse(
    readFileSync(new URL("./fixtures/ots/hello-world.expected.json", import.meta.url), "utf8"),
  ) as Array<{ height: number; commitment: string }>;
  const header = await blockHeader(expected?.height as number);
  expect(header.merkleRoot).toBe(expected?.commitment);
  expect(header.time).toEqual(new Date("2015-05-28T15:41:18Z"));
});
