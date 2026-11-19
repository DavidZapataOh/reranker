// C2SP checkpoints (https://c2sp.org/tlog-checkpoint) as signed notes
// (https://c2sp.org/signed-note) with an Ed25519 log signature over the note text.
import { createHash } from "node:crypto";
import { noteKeyId } from "@reranker/verify/trust";
import { SigningKeyMismatchError } from "../errors";
import type { Signer } from "../signer";

const ROOT_BYTES = 32;
const KEY_ID_BYTES = 4;
const ED25519_SIGNATURE_BYTES = 64;
const SIGNATURE_PREFIX = "— ";
const DECIMAL = /^(0|[1-9][0-9]*)$/;
const SIGNATURE_LINE = /^— ([^\s+]+) ([A-Za-z0-9+/]+={0,2})$/u;

const toBase64 = (bytes: Uint8Array) =>
  Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");

// Both specs require decoders to reject non-canonical base64; re-encoding is the exact test.
function fromCanonicalBase64(value: string, what: string): Uint8Array {
  const bytes = new Uint8Array(Buffer.from(value, "base64"));
  if (toBase64(bytes) !== value) throw new TypeError(`${what} is not canonical base64`);
  return bytes;
}

// The note format allows no ASCII control character other than newline.
function hasControlCharacter(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x20 && code !== 0x0a) return true;
  }
  return false;
}

function checkOrigin(origin: string): void {
  if (origin === "" || origin.includes("\n") || hasControlCharacter(origin)) {
    throw new TypeError("checkpoint origin must be one non-empty line of printable text");
  }
}

function parseBody(body: string): { origin: string; size: number; root: Uint8Array } {
  if (hasControlCharacter(body)) throw new TypeError("checkpoint contains a control character");
  if (!body.endsWith("\n")) throw new TypeError("checkpoint text must end with a newline");
  const lines = body.slice(0, -1).split("\n");
  const [origin = "", size = "", root = ""] = lines;
  if (lines.length < 3 || lines.some((line) => line === "")) {
    throw new TypeError("checkpoint text needs at least three non-empty lines");
  }
  const parsedSize = Number(size);
  if (!DECIMAL.test(size) || !Number.isSafeInteger(parsedSize)) {
    throw new TypeError("checkpoint tree size is not a canonical decimal");
  }
  const rootBytes = fromCanonicalBase64(root, "checkpoint root hash");
  if (rootBytes.length !== ROOT_BYTES) throw new TypeError("checkpoint root hash is not 32 bytes");
  return { origin, size: parsedSize, root: rootBytes };
}

/** The checkpoint note text: origin, tree size and base64 root hash, each ending in a newline. */
export function formatCheckpoint(c: { origin: string; size: number; root: Uint8Array }): string {
  checkOrigin(c.origin);
  if (!Number.isSafeInteger(c.size) || c.size < 0) {
    throw new TypeError("checkpoint tree size must be a non-negative safe integer");
  }
  if (c.root.length !== ROOT_BYTES) throw new TypeError("checkpoint root hash is not 32 bytes");
  return `${c.origin}\n${c.size}\n${toBase64(c.root)}\n`;
}

/** Appends the log's Ed25519 signature line for key `name` to a checkpoint note text. */
export async function signCheckpoint(body: string, signer: Signer, name: string): Promise<string> {
  parseBody(body);
  const keyId = noteKeyId(name, signer.publicKey);
  const sig = await signer.sign(new TextEncoder().encode(body));
  if (sig.length !== ED25519_SIGNATURE_BYTES) {
    throw new SigningKeyMismatchError(
      signer.keyid,
      `returned a ${sig.length}-byte signature, not Ed25519`,
    );
  }
  const signature = new Uint8Array(KEY_ID_BYTES + ED25519_SIGNATURE_BYTES);
  signature.set(keyId);
  signature.set(sig, KEY_ID_BYTES);
  return `${body}\n${SIGNATURE_PREFIX}${name} ${toBase64(signature)}\n`;
}

/**
 * Splits a signed checkpoint into its fields and note text. It checks the format only: the
 * signatures are for a verifier holding the log's key.
 */
export function parseCheckpoint(note: string): {
  origin: string;
  size: number;
  root: Uint8Array;
  body: string;
} {
  if (!note.endsWith("\n")) throw new TypeError("signed note must end with a newline");
  // The text ends at the last blank line; everything after it is signatures.
  const split = note.lastIndexOf("\n\n");
  if (split < 0) throw new TypeError("signed note has no signature block");
  const body = note.slice(0, split + 1);
  const signatures = note.slice(split + 2, -1);
  if (signatures === "") throw new TypeError("signed note has no signature");
  for (const line of signatures.split("\n")) {
    const match = SIGNATURE_LINE.exec(line);
    if (!match) throw new TypeError("malformed signature line");
    if (fromCanonicalBase64(match[2] ?? "", "signature").length <= KEY_ID_BYTES) {
      throw new TypeError("signature is shorter than its key ID");
    }
  }
  return { ...parseBody(body), body };
}

/** SHA-256 of the note text: the digest that gets timestamped, the same for any signature set. */
export function checkpointDigest(note: string): Uint8Array {
  return new Uint8Array(createHash("sha256").update(parseCheckpoint(note).body).digest());
}
