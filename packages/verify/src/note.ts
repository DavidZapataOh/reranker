// Signed notes (https://c2sp.org/signed-note) and the log checkpoints they carry
// (https://c2sp.org/tlog-checkpoint), checked the way golang.org/x/mod/sumdb/note opens them.
import { type Check, verifyEd25519 } from "./dsse";
import { noteKeyId, type TrustedKey } from "./trust/keys";

const KEY_ID_BYTES = 4;
const ROOT_BYTES = 32;
const PUBLIC_KEY_BYTES = 32;
// The spec asks verifiers to cap signatures and accept at least 16; Go's limit is 100.
const MAX_SIGNATURES = 100;
const SIGNATURE_PREFIX = "— ";
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const DECIMAL = /^(?:0|[1-9][0-9]*)$/;
const LONE_SURROGATE = /\p{Cs}/u;
const KEY_NAME = /^[^\p{White_Space}+]+$/u;

export type NoteSignature = { name: string; keyId: Uint8Array; sig: Uint8Array };

// Canonical only: a non-zero padding bit would give one signature two encodings.
function fromBase64(text: string): Uint8Array | null {
  if (!BASE64.test(text)) return null;
  const bytes = Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
  return btoa(String.fromCharCode(...bytes)) === text ? bytes : null;
}

// The note must be valid UTF-8 with no ASCII control character other than newline.
function isWellFormed(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x20 && code !== 0x0a) return false;
  }
  return !LONE_SURROGATE.test(text);
}

function parseSignatureLine(line: string): NoteSignature | null {
  if (!line.startsWith(SIGNATURE_PREFIX)) return null;
  const rest = line.slice(SIGNATURE_PREFIX.length);
  const space = rest.indexOf(" ");
  if (space < 0) return null;
  const name = rest.slice(0, space);
  const bytes = fromBase64(rest.slice(space + 1));
  if (!KEY_NAME.test(name) || !bytes || bytes.length <= KEY_ID_BYTES) return null;
  return { name, keyId: bytes.subarray(0, KEY_ID_BYTES), sig: bytes.subarray(KEY_ID_BYTES) };
}

/**
 * Splits a signed note into its text (final newline included) and its signature lines. It checks
 * the format only; null when the note is malformed.
 */
export function parseSignedNote(
  text: string,
): { body: string; signatures: NoteSignature[] } | null {
  if (!isWellFormed(text) || !text.endsWith("\n")) return null;
  // The text may hold empty lines: the last one separates it from the signatures.
  const split = text.lastIndexOf("\n\n");
  if (split < 0) return null;
  const lines = text.slice(split + 2, -1).split("\n");
  if (lines.length > MAX_SIGNATURES) return null;
  const signatures: NoteSignature[] = [];
  for (const line of lines) {
    const signature = parseSignatureLine(line);
    if (!signature) return null;
    signatures.push(signature);
  }
  return { body: text.slice(0, split + 1), signatures };
}

function parseCheckpointBody(
  body: string,
): { origin: string; size: number; root: Uint8Array } | null {
  const lines = body.slice(0, -1).split("\n");
  const [origin = "", size = "", root = ""] = lines;
  // Extension lines are allowed but must be non-empty, like the three fixed ones.
  if (lines.length < 3 || lines.some((line) => line === "")) return null;
  const parsedSize = Number(size);
  if (!DECIMAL.test(size) || !Number.isSafeInteger(parsedSize)) return null;
  const rootBytes = fromBase64(root);
  if (rootBytes?.length !== ROOT_BYTES) return null;
  return { origin, size: parsedSize, root: rootBytes };
}

const equalBytes = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((byte, i) => byte === b[i]);

const failure = (detail: string): { check: Check } => ({ check: { status: "fail", detail } });

/**
 * Verifies a checkpoint of the log at `origin`. The log signs under its origin as key name, so a
 * signature counts when its name and key ID match a pinned log key. Signatures from other keys
 * are ignored (witnesses may cosign); one that names a pinned key and fails rejects the note.
 */
export function verifyCheckpoint(
  note: string,
  logKeys: readonly TrustedKey[],
  origin: string,
): { check: Check; size: number; root: Uint8Array } | { check: Check } {
  const parsed = parseSignedNote(note);
  const checkpoint = parsed && parseCheckpointBody(parsed.body);
  if (!parsed || !checkpoint) return failure("malformed");
  if (checkpoint.origin !== origin) return failure("origin_mismatch");

  const pinned = KEY_NAME.test(origin)
    ? logKeys.flatMap((key) => {
        const publicKey = key.purpose === "log" ? fromBase64(key.publicKey) : null;
        return publicKey?.length === PUBLIC_KEY_BYTES
          ? [{ publicKey, keyId: noteKeyId(origin, publicKey) }]
          : [];
      })
    : [];

  const message = new TextEncoder().encode(parsed.body);
  let verified = 0;
  for (const signature of parsed.signatures) {
    if (signature.name !== origin) continue;
    const key = pinned.find((k) => equalBytes(k.keyId, signature.keyId));
    if (!key) continue;
    if (!verifyEd25519(key.publicKey, message, signature.sig)) return failure("bad_signature");
    verified++;
  }
  if (verified === 0) return failure("untrusted_log_key");
  return { check: { status: "pass" }, size: checkpoint.size, root: checkpoint.root };
}
