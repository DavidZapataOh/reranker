import { ed25519 } from "@noble/curves/ed25519.js";
import {
  CaptureStatementV1Schema,
  DSSE_PAYLOAD_TYPE,
  type DsseEnvelope,
  pae,
} from "./format/index";
import type { TrustedKey } from "./trust/keys";

export type Check = {
  status: "pass" | "fail" | "pending" | "unavailable" | "removed";
  detail?: string;
};

/**
 * RFC 8032 verification with canonical encodings only (`zip215: false`), so a signature has
 * exactly one valid encoding. Malformed input is a failed check, never an exception.
 */
export function verifyEd25519(
  publicKey: Uint8Array,
  message: Uint8Array,
  signature: Uint8Array,
): boolean {
  try {
    return ed25519.verify(signature, message, publicKey, { zip215: false });
  } catch {
    return false;
  }
}

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

// atob instead of Buffer or Uint8Array.fromBase64: it runs in every browser this page supports.
function fromBase64(text: string): Uint8Array | null {
  if (!BASE64.test(text)) return null;
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
}

const utf8 = new TextDecoder("utf-8", { fatal: true });

function parseStatement(body: Uint8Array): unknown | null {
  try {
    const parsed = CaptureStatementV1Schema.safeParse(JSON.parse(utf8.decode(body)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

const fail = (detail: string, keyid: string | null = null) => ({
  check: { status: "fail", detail } satisfies Check,
  keyid,
  statement: null,
});

/**
 * Verifies a capture statement envelope following the DSSE protocol: signatures are matched to
 * pinned capture keys by keyid (unknown ones are ignored), one valid signature is enough, and the
 * payload is parsed only once a signature over its PAE holds.
 */
export function verifyEnvelope(
  envelope: DsseEnvelope,
  keys: readonly TrustedKey[],
): { check: Check; keyid: string | null; statement: unknown | null } {
  const body = fromBase64(envelope.payload);
  if (!body) return fail("malformed");

  const known = envelope.signatures.flatMap((signature) => {
    const key = keys.find((k) => k.purpose === "capture" && k.keyid === signature.keyid);
    return key ? [{ key, signature }] : [];
  });
  if (known.length === 0) return fail("unknown_key");

  const message = pae(envelope.payloadType, body);
  const verified = known.find(({ key, signature }) => {
    const publicKey = fromBase64(key.publicKey);
    const sig = fromBase64(signature.sig);
    return publicKey !== null && sig !== null && verifyEd25519(publicKey, message, sig);
  });
  if (!verified) return fail("bad_signature");

  const { keyid } = verified.key;
  if (envelope.payloadType !== DSSE_PAYLOAD_TYPE) return fail("payload_type", keyid);
  const statement = parseStatement(body);
  if (statement === null) return fail("invalid_statement", keyid);
  return { check: { status: "pass" }, keyid, statement };
}
