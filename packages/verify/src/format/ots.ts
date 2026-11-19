import { ripemd160 } from "@noble/hashes/legacy.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, concatBytes } from "@noble/hashes/utils.js";

// The OpenTimestamps proof format as python-opentimestamps defines it (core/serialize.py,
// core/op.py, core/notary.py, core/timestamp.py), limited to the operations calendars emit.

export type OtsOp = { op: "append" | "prepend"; arg: Uint8Array } | { op: "sha256" | "ripemd160" };

export type OtsAttestation =
  | { kind: "pending"; uri: string }
  | { kind: "bitcoin"; height: number }
  /** A notary this codec does not know; kept byte for byte so newer proofs survive a rewrite. */
  | { kind: "unknown"; tag: Uint8Array; payload: Uint8Array };

export interface OtsTimestamp {
  msg: Uint8Array;
  attestations: OtsAttestation[];
  ops: Array<{ op: OtsOp; next: OtsTimestamp }>;
}

export class OtsFormatError extends Error {
  override readonly name = "OtsFormatError";
}

const MAGIC = new Uint8Array([
  0x00, 0x4f, 0x70, 0x65, 0x6e, 0x54, 0x69, 0x6d, 0x65, 0x73, 0x74, 0x61, 0x6d, 0x70, 0x73, 0x00,
  0x00, 0x50, 0x72, 0x6f, 0x6f, 0x66, 0x00, 0xbf, 0x89, 0xe2, 0xe8, 0x84, 0xe8, 0x92, 0x94,
]);
const MAJOR_VERSION = 1;
const MAX_MSG_LENGTH = 4096;
const MAX_PAYLOAD_LENGTH = 8192;
const MAX_URI_LENGTH = 1000;
const MAX_HEIGHT = 2 ** 32 - 1;
const MAX_VARUINT_BYTES = 9;
const MAX_DEPTH = 256;
const ALLOWED_URI = /^[A-Za-z0-9\-._/:]*$/;

const OP_TAG = { sha256: 0x08, ripemd160: 0x03, append: 0xf0, prepend: 0xf1 } as const;
const PENDING_TAG = new Uint8Array([0x83, 0xdf, 0xe3, 0x0d, 0x2e, 0xf9, 0x0c, 0x8e]);
const BITCOIN_TAG = new Uint8Array([0x05, 0x88, 0x96, 0x0d, 0x73, 0xd7, 0x19, 0x01]);
const ATTESTATION = 0x00;
const FORK = 0xff;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

class Reader {
  private pos = 0;
  private readonly bytes: Uint8Array;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }

  byte(): number {
    return this.take(1)[0] as number;
  }

  take(n: number): Uint8Array {
    if (this.pos + n > this.bytes.length) throw new OtsFormatError("Truncated proof");
    const out = this.bytes.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  varuint(): number {
    let value = 0;
    for (let i = 0; i < MAX_VARUINT_BYTES; i++) {
      const b = this.byte();
      value += (b & 0x7f) * 2 ** (7 * i);
      if (!(b & 0x80)) return value;
    }
    throw new OtsFormatError(`varuint exceeds ${MAX_VARUINT_BYTES} bytes`);
  }

  varbytes(max: number, min = 0): Uint8Array {
    const length = this.varuint();
    if (length > max || length < min) {
      throw new OtsFormatError(`varbytes length ${length} outside ${min}..${max}`);
    }
    return this.take(length);
  }

  end(): void {
    if (this.pos !== this.bytes.length) throw new OtsFormatError("Trailing bytes after proof");
  }
}

class Writer {
  private readonly parts: Uint8Array[] = [];

  bytes(...chunks: Array<Uint8Array | number[]>): void {
    for (const c of chunks) this.parts.push(c instanceof Uint8Array ? c : new Uint8Array(c));
  }

  varuint(value: number): void {
    const out: number[] = [];
    let v = value;
    do {
      const low = v % 0x80;
      v = Math.floor(v / 0x80);
      out.push(v > 0 ? low | 0x80 : low);
    } while (v > 0);
    this.bytes(out);
  }

  varbytes(b: Uint8Array): void {
    this.varuint(b.length);
    this.bytes(b);
  }

  done(): Uint8Array {
    return concatBytes(...this.parts);
  }
}

function applyOp(op: OtsOp, msg: Uint8Array): Uint8Array {
  if (msg.length > MAX_MSG_LENGTH) throw new OtsFormatError("Message exceeds 4096 bytes");
  const result =
    op.op === "append"
      ? concatBytes(msg, op.arg)
      : op.op === "prepend"
        ? concatBytes(op.arg, msg)
        : op.op === "sha256"
          ? sha256(msg)
          : ripemd160(msg);
  if (result.length > MAX_MSG_LENGTH)
    throw new OtsFormatError("Operation result exceeds 4096 bytes");
  return result;
}

function readOp(r: Reader, tag: number): OtsOp {
  switch (tag) {
    case OP_TAG.sha256:
      return { op: "sha256" };
    case OP_TAG.ripemd160:
      return { op: "ripemd160" };
    case OP_TAG.append:
      return { op: "append", arg: r.varbytes(MAX_MSG_LENGTH, 1).slice() };
    case OP_TAG.prepend:
      return { op: "prepend", arg: r.varbytes(MAX_MSG_LENGTH, 1).slice() };
    default:
      throw new OtsFormatError(`Unknown operation tag 0x${tag.toString(16)}`);
  }
}

function readAttestation(r: Reader): OtsAttestation {
  const tag = r.take(8).slice();
  const payload = r.varbytes(MAX_PAYLOAD_LENGTH).slice();
  const p = new Reader(payload);
  let attestation: OtsAttestation;
  if (sameBytes(tag, PENDING_TAG)) {
    const uri = p.varbytes(MAX_URI_LENGTH);
    if (!ALLOWED_URI.test(decoder.decode(uri))) throw new OtsFormatError("Invalid calendar URI");
    attestation = { kind: "pending", uri: decoder.decode(uri) };
  } else if (sameBytes(tag, BITCOIN_TAG)) {
    const height = p.varuint();
    if (height > MAX_HEIGHT) throw new OtsFormatError(`Block height ${height} too large`);
    attestation = { kind: "bitcoin", height };
  } else {
    return { kind: "unknown", tag, payload };
  }
  p.end();
  return attestation;
}

function readTimestamp(r: Reader, msg: Uint8Array, depth: number): OtsTimestamp {
  if (depth === 0) throw new OtsFormatError(`Proof nests deeper than ${MAX_DEPTH} operations`);
  const node: OtsTimestamp = { msg, attestations: [], ops: [] };
  const read = (tag: number) => {
    if (tag === ATTESTATION) {
      const attestation = readAttestation(r);
      if (!node.attestations.some((a) => compareAttestations(a, attestation) === 0)) {
        node.attestations.push(attestation);
      }
      return;
    }
    const op = readOp(r, tag);
    if (node.ops.some((o) => compareOps(o.op, op) === 0)) {
      throw new OtsFormatError(`Operation ${op.op} repeated`);
    }
    node.ops.push({ op, next: readTimestamp(r, applyOp(op, msg), depth - 1) });
  };
  let tag = r.byte();
  while (tag === FORK) {
    read(r.byte());
    tag = r.byte();
  }
  read(tag);
  return node;
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return (a[i] as number) - (b[i] as number);
  }
  return a.length - b.length;
}

const sameBytes = (a: Uint8Array, b: Uint8Array) => compareBytes(a, b) === 0;

const attestationTag = (a: OtsAttestation) =>
  a.kind === "pending" ? PENDING_TAG : a.kind === "bitcoin" ? BITCOIN_TAG : a.tag;

// The reference client orders attestations by tag, then by URI, height or raw payload.
function compareAttestations(a: OtsAttestation, b: OtsAttestation): number {
  const byTag = compareBytes(attestationTag(a), attestationTag(b));
  if (byTag !== 0) return byTag;
  if (a.kind === "pending" && b.kind === "pending")
    return compareBytes(encoder.encode(a.uri), encoder.encode(b.uri));
  if (a.kind === "bitcoin" && b.kind === "bitcoin") return a.height - b.height;
  if (a.kind === "unknown" && b.kind === "unknown") return compareBytes(a.payload, b.payload);
  return 0;
}

// Ops sort by tag, then by argument, as python-opentimestamps' Op.__lt__ does.
function compareOps(a: OtsOp, b: OtsOp): number {
  if (a.op !== b.op) return OP_TAG[a.op] - OP_TAG[b.op];
  return "arg" in a && "arg" in b ? compareBytes(a.arg, b.arg) : 0;
}

function writeAttestation(w: Writer, a: OtsAttestation): void {
  const payload = new Writer();
  if (a.kind === "pending") payload.varbytes(encoder.encode(a.uri));
  else if (a.kind === "bitcoin") payload.varuint(a.height);
  else payload.bytes(a.payload);
  w.bytes(attestationTag(a));
  w.varbytes(payload.done());
}

function writeOp(w: Writer, op: OtsOp): void {
  w.bytes([OP_TAG[op.op]]);
  if ("arg" in op) w.varbytes(op.arg);
}

function writeTimestamp(w: Writer, t: OtsTimestamp): void {
  if (t.attestations.length === 0 && t.ops.length === 0) {
    throw new OtsFormatError("An empty timestamp cannot be serialized");
  }
  const attestations = [...t.attestations].sort(compareAttestations);
  const ops = [...t.ops].sort((a, b) => compareOps(a.op, b.op));
  const last = attestations.pop();
  for (const a of attestations) {
    w.bytes([FORK, ATTESTATION]);
    writeAttestation(w, a);
  }
  if (ops.length === 0) {
    w.bytes([ATTESTATION]);
    writeAttestation(w, last as OtsAttestation);
    return;
  }
  if (last) {
    w.bytes([FORK, ATTESTATION]);
    writeAttestation(w, last);
  }
  ops.forEach(({ op, next }, i) => {
    if (i < ops.length - 1) w.bytes([FORK]);
    writeOp(w, op);
    writeTimestamp(w, next);
  });
}

/** Parses a calendar answer: a bare timestamp over `msg`, the message that was submitted. */
export function parseOtsTimestamp(bytes: Uint8Array, msg: Uint8Array): OtsTimestamp {
  const r = new Reader(bytes);
  const timestamp = readTimestamp(r, msg.slice(), MAX_DEPTH);
  r.end();
  return timestamp;
}

export function serializeOtsTimestamp(t: OtsTimestamp): Uint8Array {
  const w = new Writer();
  writeTimestamp(w, t);
  return w.done();
}

/** Reads a detached `.ots` file over a SHA-256 digest, the only file hash the evidence log uses. */
export function parseDetachedOts(bytes: Uint8Array): {
  digest: Uint8Array;
  timestamp: OtsTimestamp;
} {
  const r = new Reader(bytes);
  if (!sameBytes(r.take(MAGIC.length), MAGIC))
    throw new OtsFormatError("Not an OpenTimestamps proof");
  const major = r.byte();
  if (major !== MAJOR_VERSION) throw new OtsFormatError(`Unsupported major version ${major}`);
  if (r.byte() !== OP_TAG.sha256) throw new OtsFormatError("File digest is not SHA-256");
  const digest = r.take(32).slice();
  const timestamp = readTimestamp(r, digest, MAX_DEPTH);
  r.end();
  return { digest, timestamp };
}

export function serializeDetachedOts(digest: Uint8Array, timestamp: OtsTimestamp): Uint8Array {
  if (digest.length !== 32 || !sameBytes(digest, timestamp.msg)) {
    throw new OtsFormatError("The timestamp is not over this SHA-256 digest");
  }
  const w = new Writer();
  w.bytes(MAGIC, [MAJOR_VERSION, OP_TAG.sha256], digest);
  writeTimestamp(w, timestamp);
  return w.done();
}

/** Adds `other`'s paths and attestations into `into`; true when an attestation was added. */
export function mergeOtsTimestamps(into: OtsTimestamp, other: OtsTimestamp): boolean {
  if (!sameBytes(into.msg, other.msg)) {
    throw new OtsFormatError("Cannot merge timestamps over different messages");
  }
  let changed = false;
  for (const a of other.attestations) {
    if (!into.attestations.some((b) => compareAttestations(a, b) === 0)) {
      into.attestations.push(a);
      changed = true;
    }
  }
  for (const { op, next } of other.ops) {
    let ours = into.ops.find((o) => compareOps(o.op, op) === 0)?.next;
    if (!ours) {
      ours = { msg: applyOp(op, into.msg), attestations: [], ops: [] };
      into.ops.push({ op, next: ours });
    }
    changed = mergeOtsTimestamps(ours, next) || changed;
  }
  return changed;
}

/** Every attestation with the message it commits to, recomputed from the root's message. */
export function replay(t: OtsTimestamp): Array<{ attestation: OtsAttestation; msg: Uint8Array }> {
  const out: Array<{ attestation: OtsAttestation; msg: Uint8Array }> = [];
  const walk = (node: OtsTimestamp, msg: Uint8Array) => {
    for (const attestation of node.attestations) out.push({ attestation, msg });
    for (const { op, next } of node.ops) walk(next, applyOp(op, msg));
  };
  walk(t, t.msg);
  return out;
}

/**
 * Bitcoin attestations with the merkle root their block must carry, in the byte-reversed hex
 * that block explorers and `ots info` print.
 */
export function bitcoinAttestations(
  t: OtsTimestamp,
): Array<{ height: number; commitment: string }> {
  return replay(t).flatMap(({ attestation, msg }) =>
    attestation.kind === "bitcoin"
      ? [{ height: attestation.height, commitment: bytesToHex(msg.slice().reverse()) }]
      : [],
  );
}
