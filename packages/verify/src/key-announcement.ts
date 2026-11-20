import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { type Check, fromBase64, verifyEd25519 } from "./dsse";
import {
  DSSE_PAYLOAD_TYPE,
  type DsseEnvelope,
  type KeyAnnouncementStatementV1,
  KeyAnnouncementStatementV1Schema,
  pae,
} from "./format/index";
import type { TrustedKey } from "./trust/keys";

const utf8 = new TextDecoder("utf-8", { fatal: true });

function parseStatement(body: Uint8Array): KeyAnnouncementStatementV1 | null {
  try {
    const parsed = KeyAnnouncementStatementV1Schema.safeParse(JSON.parse(utf8.decode(body)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

const fail = (detail: string) => ({ check: { status: "fail", detail } as Check, statement: null });

/** Whether the announcement states exactly what the registry pins for the key. */
function matchesPinned(statement: KeyAnnouncementStatementV1, pinned: TrustedKey): boolean {
  const { key } = statement.predicate;
  const publicKey = fromBase64(pinned.publicKey);
  const [subject] = statement.subject;
  return (
    publicKey !== null &&
    key.public_key === pinned.publicKey &&
    key.purpose === pinned.purpose &&
    key.env === pinned.env &&
    key.alg === pinned.alg &&
    key.custody === pinned.custody &&
    key.valid_from === pinned.validFrom &&
    subject?.name === pinned.keyid &&
    subject.digest.sha256 === bytesToHex(sha256(publicKey))
  );
}

/**
 * Verifies a `key-announcement/v1` envelope against the pinned keys. The announced key must sign
 * it (it is held by whoever announces it), as must its predecessor when it has one (the holder of
 * the old key hands over) and a log key of the same environment (the log it enters endorses it).
 * The payload is parsed only after at least one signature over its PAE holds.
 */
export function verifyKeyAnnouncement(
  envelope: DsseEnvelope,
  keys: readonly TrustedKey[],
): { check: Check; statement: KeyAnnouncementStatementV1 | null } {
  const body = fromBase64(envelope.payload);
  if (!body) return fail("malformed");

  const known = envelope.signatures.flatMap((signature) => {
    const key = keys.find((k) => k.keyid === signature.keyid);
    return key ? [{ key, signature }] : [];
  });
  if (known.length === 0) return fail("unknown_key");

  const message = pae(envelope.payloadType, body);
  const signedBy = known.flatMap(({ key, signature }) => {
    const publicKey = fromBase64(key.publicKey);
    const sig = fromBase64(signature.sig);
    return publicKey !== null && sig !== null && verifyEd25519(publicKey, message, sig)
      ? [key]
      : [];
  });
  if (signedBy.length === 0) return fail("bad_signature");

  if (envelope.payloadType !== DSSE_PAYLOAD_TYPE) return fail("payload_type");
  const statement = parseStatement(body);
  if (statement === null) return fail("invalid_statement");

  const { key, previous } = statement.predicate;
  const pinned = keys.find((k) => k.keyid === key.keyid);
  if (!pinned) return fail("unpinned_key");
  if (!matchesPinned(statement, pinned)) return fail("key_mismatch");
  const predecessor = previous && keys.find((k) => k.keyid === previous.keyid);
  if (previous && predecessor?.purpose !== key.purpose) return fail("key_mismatch");
  if (previous && predecessor?.env !== key.env) return fail("key_mismatch");

  const signed = (keyid: string) => signedBy.some((k) => k.keyid === keyid);
  const endorsed = signedBy.some((k) => k.purpose === "log" && k.env === key.env);
  if (!signed(key.keyid) || (previous && !signed(previous.keyid)) || !endorsed) {
    return fail("missing_signature");
  }
  return { check: { status: "pass" }, statement };
}
