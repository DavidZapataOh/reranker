import { createHash } from "node:crypto";

// Block headers from two Esplora instances run by different operators (Esplora API.md:
// GET /block-height/:height and GET /block/:hash/header). Both must name the same block, and the
// header must hash to it, so neither can confirm a proof alone.
export const ESPLORA_APIS = ["https://blockstream.info/api", "https://mempool.space/api"] as const;

const TIMEOUT_MS = 10_000;
const HEADER_BYTES = 80;
const BLOCK_HASH = /^[0-9a-f]{64}$/;

/** The explorers disagree or cannot answer; the same lookup succeeds later. */
export class BlockHeaderUnavailableError extends Error {
  override readonly name = "BlockHeaderUnavailable";
}

const sha256d = (bytes: Uint8Array) =>
  createHash("sha256").update(createHash("sha256").update(bytes).digest()).digest();
// Bitcoin prints hashes byte-reversed; OpenTimestamps commitments use the same order.
const displayHex = (bytes: Uint8Array) => Buffer.from(bytes).reverse().toString("hex");

async function get(url: string, fetchImpl: typeof fetch): Promise<string> {
  const response = await fetchImpl(url, {
    redirect: "error",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = (await response.text()).trim();
  if (response.status !== 200) {
    throw new BlockHeaderUnavailableError(`${url} answered ${response.status}`);
  }
  return text;
}

/** The merkle root and time of the block at `height`, from a header both explorers agree on. */
export async function blockHeader(
  height: number,
  opts: { fetch?: typeof fetch } = {},
): Promise<{ hash: string; merkleRoot: string; time: Date }> {
  const fetchImpl = opts.fetch ?? fetch;
  const hashes = await Promise.all(
    ESPLORA_APIS.map((api) => get(`${api}/block-height/${height}`, fetchImpl)),
  );
  const [hash] = hashes;
  if (!hash || !BLOCK_HASH.test(hash) || hashes.some((h) => h !== hash)) {
    throw new BlockHeaderUnavailableError(`Explorers disagree on block ${height}`);
  }
  const header = new Uint8Array(
    Buffer.from(await get(`${ESPLORA_APIS[0]}/block/${hash}/header`, fetchImpl), "hex"),
  );
  if (header.length !== HEADER_BYTES || displayHex(sha256d(header)) !== hash) {
    throw new BlockHeaderUnavailableError(`Header of block ${height} does not hash to ${hash}`);
  }
  const time = new DataView(header.buffer).getUint32(68, true);
  return { hash, merkleRoot: displayHex(header.subarray(36, 68)), time: new Date(time * 1000) };
}
