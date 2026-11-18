import { ripemd160 } from "@noble/hashes/legacy.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, concatBytes, hexToBytes } from "@noble/hashes/utils.js";
import { describe, expect, test } from "vitest";
import {
  bitcoinAttestations,
  mergeOtsTimestamps,
  OtsFormatError,
  type OtsOp,
  type OtsTimestamp,
  parseDetachedOts,
  parseOtsTimestamp,
  replay,
  serializeDetachedOts,
  serializeOtsTimestamp,
} from "../src/format/index";

const MAGIC = hexToBytes("004f70656e54696d657374616d7073000050726f6f6600bf89e2e884e89294");
const PENDING_TAG = hexToBytes("83dfe30d2ef90c8e");
const BITCOIN_TAG = hexToBytes("0588960d73d71901");
const digest = sha256(new TextEncoder().encode("reranker"));

const stamp = (msg: Uint8Array): OtsTimestamp => ({ msg, attestations: [], ops: [] });
const apply = (op: OtsOp, msg: Uint8Array) =>
  op.op === "append"
    ? concatBytes(msg, op.arg)
    : op.op === "prepend"
      ? concatBytes(op.arg, msg)
      : op.op === "sha256"
        ? sha256(msg)
        : ripemd160(msg);
const chain = (from: OtsTimestamp, ops: OtsOp[]): OtsTimestamp =>
  ops.reduce((node, op) => {
    const next = stamp(apply(op, node.msg));
    node.ops.push({ op, next });
    return next;
  }, from);

/** A calendar-shaped proof: nonce, sha256, then a pending attestation for `uri`. */
function pendingProof(msg: Uint8Array, uri: string, nonce = "11".repeat(16)): OtsTimestamp {
  const root = stamp(msg);
  chain(root, [{ op: "append", arg: hexToBytes(nonce) }, { op: "sha256" }]).attestations.push({
    kind: "pending",
    uri,
  });
  return root;
}

const varbytes = (b: Uint8Array) => concatBytes(new Uint8Array([b.length]), b);
const detached = (body: Uint8Array, version = 1, fileOp = 0x08, d = digest) =>
  concatBytes(MAGIC, new Uint8Array([version, fileOp]), d, body);
const pendingBody = (uri: string) =>
  concatBytes(
    new Uint8Array([0x00]),
    PENDING_TAG,
    varbytes(varbytes(new TextEncoder().encode(uri))),
  );

describe("detached files", () => {
  test("a two-calendar proof round-trips byte for byte", () => {
    const root = pendingProof(digest, "https://alice.btc.calendar.opentimestamps.org");
    mergeOtsTimestamps(
      root,
      pendingProof(digest, "https://bob.btc.calendar.opentimestamps.org", "22".repeat(16)),
    );
    const bytes = serializeDetachedOts(digest, root);
    const parsed = parseDetachedOts(bytes);
    expect(parsed.digest).toEqual(digest);
    expect(serializeDetachedOts(parsed.digest, parsed.timestamp)).toEqual(bytes);
  });

  test("attestations and ops serialize in the reference client's canonical order", () => {
    const a = stamp(digest);
    a.attestations.push(
      { kind: "bitcoin", height: 900_000 },
      { kind: "pending", uri: "https://b.example" },
      { kind: "pending", uri: "https://a.example" },
      { kind: "bitcoin", height: 12 },
      { kind: "unknown", tag: hexToBytes("ffffffffffffffff"), payload: hexToBytes("02") },
      { kind: "unknown", tag: hexToBytes("ffffffffffffffff"), payload: hexToBytes("01") },
    );
    chain(a, [{ op: "prepend", arg: hexToBytes("aa") }]).attestations.push({
      kind: "bitcoin",
      height: 1,
    });
    chain(a, [{ op: "append", arg: hexToBytes("bbcc") }]).attestations.push({
      kind: "bitcoin",
      height: 2,
    });
    chain(a, [{ op: "append", arg: hexToBytes("bb") }]).attestations.push({
      kind: "bitcoin",
      height: 3,
    });
    chain(a, [{ op: "sha256" }]).attestations.push({ kind: "bitcoin", height: 4 });
    chain(a, [{ op: "ripemd160" }]).attestations.push({ kind: "bitcoin", height: 5 });

    const parsed = parseDetachedOts(serializeDetachedOts(digest, a)).timestamp;
    expect(parsed.attestations).toEqual([
      { kind: "bitcoin", height: 12 },
      { kind: "bitcoin", height: 900_000 },
      { kind: "pending", uri: "https://a.example" },
      { kind: "pending", uri: "https://b.example" },
      { kind: "unknown", tag: hexToBytes("ffffffffffffffff"), payload: hexToBytes("01") },
      { kind: "unknown", tag: hexToBytes("ffffffffffffffff"), payload: hexToBytes("02") },
    ]);
    expect(parsed.ops.map(({ op }) => op)).toEqual([
      { op: "ripemd160" },
      { op: "sha256" },
      { op: "append", arg: hexToBytes("bb") },
      { op: "append", arg: hexToBytes("bbcc") },
      { op: "prepend", arg: hexToBytes("aa") },
    ]);
  });

  test("unknown attestation tags are preserved, never dropped", () => {
    const tag = hexToBytes("06869a0d73d71b45");
    const payload = hexToBytes("8f8a16");
    const bytes = detached(concatBytes(new Uint8Array([0x00]), tag, varbytes(payload)));
    const { timestamp } = parseDetachedOts(bytes);
    expect(timestamp.attestations).toEqual([{ kind: "unknown", tag, payload }]);
    expect(serializeDetachedOts(digest, timestamp)).toEqual(bytes);
  });

  test("a duplicated attestation collapses like the reference client's set", () => {
    const bytes = detached(
      concatBytes(
        new Uint8Array([0xff]),
        pendingBody("https://a.example"),
        pendingBody("https://a.example"),
      ),
    );
    expect(parseDetachedOts(bytes).timestamp.attestations).toEqual([
      { kind: "pending", uri: "https://a.example" },
    ]);
  });

  test.each([
    [
      "bad magic",
      concatBytes(new Uint8Array([1]), detached(pendingBody("https://a.example")).slice(1)),
    ],
    ["major version 2", detached(pendingBody("https://a.example"), 2)],
    ["a non-SHA-256 file digest", detached(pendingBody("https://a.example"), 1, 0x02)],
    ["a truncated digest", detached(new Uint8Array(), 1, 0x08, digest.slice(0, 10))],
    [
      "trailing garbage",
      concatBytes(detached(pendingBody("https://a.example")), new Uint8Array([0])),
    ],
    ["an unknown op tag", detached(new Uint8Array([0x67, 0x00]))],
    ["an empty append argument", detached(new Uint8Array([0xf0, 0x00]))],
    [
      "a repeated op",
      detached(
        concatBytes(
          new Uint8Array([0xff, 0x08]),
          pendingBody("x"),
          new Uint8Array([0x08]),
          pendingBody("x"),
        ),
      ),
    ],
    ["a URI with forbidden characters", detached(pendingBody("https://a.example/?q=1"))],
    [
      "a varuint over 9 bytes",
      detached(concatBytes(new Uint8Array([0x00]), PENDING_TAG, new Uint8Array(10).fill(0x80))),
    ],
    [
      "a pending payload with extra bytes",
      detached(
        concatBytes(
          new Uint8Array([0x00]),
          PENDING_TAG,
          varbytes(concatBytes(varbytes(new TextEncoder().encode("x")), new Uint8Array([1]))),
        ),
      ),
    ],
    [
      "a block height over 2^32 - 1",
      detached(
        concatBytes(new Uint8Array([0x00]), BITCOIN_TAG, varbytes(hexToBytes("8080808010"))),
      ),
    ],
    [
      "an append past 4096 bytes",
      detached(concatBytes(new Uint8Array([0xf0]), hexToBytes("e11f"), new Uint8Array(4065))),
    ],
  ])("rejects %s", (_, bytes) => expect(() => parseDetachedOts(bytes)).toThrow(OtsFormatError));

  test("rejects nesting deeper than 256 operations", () => {
    const deep = (n: number) =>
      detached(concatBytes(new Uint8Array(n).fill(0x08), pendingBody("https://a.example")));
    expect(() => parseDetachedOts(deep(255))).not.toThrow();
    expect(() => parseDetachedOts(deep(256))).toThrow(OtsFormatError);
  });

  test("an empty timestamp cannot be serialized", () =>
    expect(() => serializeDetachedOts(digest, stamp(digest))).toThrow(OtsFormatError));

  test("the digest must be the timestamp's message", () =>
    expect(() =>
      serializeDetachedOts(digest, pendingProof(sha256(digest), "https://a.example")),
    ).toThrow(OtsFormatError));
});

describe("calendar answers", () => {
  test("a bare timestamp parses against the submitted message", () => {
    const proof = pendingProof(digest, "https://alice.btc.calendar.opentimestamps.org");
    const bytes = serializeOtsTimestamp(proof);
    expect(serializeOtsTimestamp(parseOtsTimestamp(bytes, digest))).toEqual(bytes);
    expect(() => parseOtsTimestamp(concatBytes(bytes, new Uint8Array([0])), digest)).toThrow(
      OtsFormatError,
    );
    expect(() => parseOtsTimestamp(bytes.slice(0, -1), digest)).toThrow(OtsFormatError);
  });

  test("merging adds new paths and attestations and reports whether anything changed", () => {
    const into = pendingProof(digest, "https://alice.btc.calendar.opentimestamps.org");
    const upgrade = pendingProof(digest, "https://alice.btc.calendar.opentimestamps.org");
    const tip = chain(upgrade.ops[0]?.next.ops[0]?.next as OtsTimestamp, [{ op: "sha256" }]);
    tip.attestations.push({ kind: "bitcoin", height: 800_000 });

    expect(mergeOtsTimestamps(into, upgrade)).toBe(true);
    expect(mergeOtsTimestamps(into, upgrade)).toBe(false);
    expect(replay(into).map(({ attestation }) => attestation)).toEqual([
      { kind: "pending", uri: "https://alice.btc.calendar.opentimestamps.org" },
      { kind: "bitcoin", height: 800_000 },
    ]);
    expect(() => mergeOtsTimestamps(into, stamp(sha256(digest)))).toThrow(OtsFormatError);
  });
});

describe("replay and Bitcoin attestations", () => {
  test("replay recomputes every message from the digest instead of trusting stored ones", () => {
    const root = stamp(digest);
    const leaf = chain(root, [{ op: "prepend", arg: hexToBytes("00") }, { op: "ripemd160" }]);
    leaf.attestations.push({ kind: "bitcoin", height: 7 });
    leaf.msg = new Uint8Array(20);
    expect(replay(root)).toEqual([
      {
        attestation: { kind: "bitcoin", height: 7 },
        msg: ripemd160(concatBytes(new Uint8Array([0]), digest)),
      },
    ]);
  });

  test("the commitment is the merkle root in block-explorer byte order", () => {
    const root = stamp(digest);
    chain(root, [{ op: "sha256" }]).attestations.push({ kind: "bitcoin", height: 358_391 });
    root.attestations.push({ kind: "pending", uri: "https://a.example" });
    expect(bitcoinAttestations(root)).toEqual([
      { height: 358_391, commitment: bytesToHex(sha256(digest).reverse()) },
    ]);
  });
});
