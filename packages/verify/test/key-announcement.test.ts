import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { expect, test } from "vitest";
import {
  DSSE_PAYLOAD_TYPE,
  type DsseEnvelope,
  IN_TOTO_STATEMENT_V1,
  type KeyAnnouncementStatementV1,
  PREDICATE,
  pae,
} from "../src/format/index";
import { verifyKeyAnnouncement } from "../src/key-announcement";
import type { TrustedKey } from "../src/trust/keys";

const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

function keyPair(keyid: string, purpose: TrustedKey["purpose"], env: TrustedKey["env"]) {
  const secretKey = ed25519.utils.randomSecretKey();
  const key: TrustedKey = {
    keyid,
    purpose,
    env,
    alg: "Ed25519",
    publicKey: b64(ed25519.getPublicKey(secretKey)),
    custody: "aws-kms-hsm",
    validFrom: "2026-11-20T18:29:31.132Z",
    validTo: null,
    compromisedAfter: null,
  };
  return { key, secretKey };
}

const capture = keyPair("rr-capture-preview-2026-1-ed25519", "capture", "preview");
const log = keyPair("rr-log-preview-2026-1", "log", "preview");
const nextCapture = keyPair("rr-capture-preview-2026-2-ed25519", "capture", "preview");
const productionLog = keyPair("rr-log-2026-1", "log", "production");
const keys = [capture, log, nextCapture, productionLog].map((k) => k.key);
const signers = new Map([capture, log, nextCapture, productionLog].map((k) => [k.key.keyid, k]));

function announcement(key: TrustedKey, previous: string | null = null): KeyAnnouncementStatementV1 {
  const publicKey = Uint8Array.from(atob(key.publicKey), (c) => c.charCodeAt(0));
  return {
    _type: IN_TOTO_STATEMENT_V1,
    subject: [{ name: key.keyid, digest: { sha256: bytesToHex(sha256(publicKey)) } }],
    predicateType: PREDICATE.keyAnnouncement,
    predicate: {
      key: {
        keyid: key.keyid,
        purpose: key.purpose,
        env: key.env,
        alg: "Ed25519",
        public_key: key.publicKey,
        custody: key.custody,
        valid_from: key.validFrom,
      },
      previous: previous === null ? null : { keyid: previous },
      time: { worker_utc: "2026-11-20T19:00:00.000Z" },
      worker: { id: "iad1", image_digest: `git:${"a".repeat(40)}` },
    },
  };
}

function sign(statement: unknown, keyids: string[]): DsseEnvelope {
  const body = new TextEncoder().encode(JSON.stringify(statement));
  const message = pae(DSSE_PAYLOAD_TYPE, body);
  return {
    payloadType: DSSE_PAYLOAD_TYPE,
    payload: b64(body),
    signatures: keyids.map((keyid) => {
      const signer = signers.get(keyid);
      if (!signer) throw new Error(keyid);
      return { keyid, sig: b64(ed25519.sign(message, signer.secretKey)) };
    }),
  };
}

const detail = (envelope: DsseEnvelope) => verifyKeyAnnouncement(envelope, keys).check;

test("a capture key announced with its own signature and the log key's verifies", () => {
  const statement = announcement(capture.key);
  const result = verifyKeyAnnouncement(sign(statement, [capture.key.keyid, log.key.keyid]), keys);
  expect(result).toEqual({ check: { status: "pass" }, statement });
});

test("the log key announces itself with one signature", () => {
  expect(detail(sign(announcement(log.key), [log.key.keyid]))).toEqual({ status: "pass" });
});

test.each([
  ["the announced key", [log.key.keyid]],
  ["the log key", [capture.key.keyid]],
  ["a log key of the same environment", [capture.key.keyid, productionLog.key.keyid]],
])("an announcement without %s is rejected", (_, keyids) => {
  expect(detail(sign(announcement(capture.key), keyids))).toEqual({
    status: "fail",
    detail: "missing_signature",
  });
});

test("a successor needs its predecessor's signature", () => {
  const statement = announcement(nextCapture.key, capture.key.keyid);
  const own = [nextCapture.key.keyid, log.key.keyid];
  expect(detail(sign(statement, own))).toEqual({ status: "fail", detail: "missing_signature" });
  expect(detail(sign(statement, [...own, capture.key.keyid]))).toEqual({ status: "pass" });
});

test("a predecessor of another purpose or environment is rejected", () => {
  const statement = announcement(nextCapture.key, productionLog.key.keyid);
  const all = [nextCapture.key.keyid, log.key.keyid, productionLog.key.keyid];
  expect(detail(sign(statement, all))).toEqual({ status: "fail", detail: "key_mismatch" });
});

test("an announcement that disagrees with the pinned key is rejected", () => {
  const signedBy = [capture.key.keyid, log.key.keyid];
  const swapped = announcement(capture.key);
  swapped.predicate.key.public_key = nextCapture.key.publicKey;
  expect(detail(sign(swapped, signedBy))).toEqual({ status: "fail", detail: "key_mismatch" });

  const subject = announcement(capture.key);
  subject.subject = [{ name: capture.key.keyid, digest: { sha256: "0".repeat(64) } }];
  expect(detail(sign(subject, signedBy))).toEqual({ status: "fail", detail: "key_mismatch" });

  const custody = announcement(capture.key);
  custody.predicate.key.custody = "gcp-kms-software";
  expect(detail(sign(custody, signedBy))).toEqual({ status: "fail", detail: "key_mismatch" });
});

test("a key missing from the pinned registry is rejected even when the log key signed it", () => {
  const unpinned = keyPair("rr-capture-preview-2026-9-ed25519", "capture", "preview");
  signers.set(unpinned.key.keyid, unpinned);
  const envelope = sign(announcement(unpinned.key), [unpinned.key.keyid, log.key.keyid]);
  expect(detail(envelope)).toEqual({ status: "fail", detail: "unpinned_key" });
});

test("envelopes with no trusted signature, a forged one or another payload are rejected", () => {
  const envelope = sign(announcement(capture.key), [capture.key.keyid, log.key.keyid]);
  expect(detail({ ...envelope, payload: "not base64!" })).toEqual({
    status: "fail",
    detail: "malformed",
  });
  expect(detail({ ...envelope, signatures: [{ keyid: "rr-unknown", sig: "AAAA" }] })).toEqual({
    status: "fail",
    detail: "unknown_key",
  });
  const forged = { ...envelope, payload: b64(new TextEncoder().encode("{}")) };
  expect(detail(forged)).toEqual({ status: "fail", detail: "bad_signature" });

  const capturePredicate = { ...announcement(capture.key), predicateType: PREDICATE.capture };
  expect(detail(sign(capturePredicate, [capture.key.keyid, log.key.keyid]))).toEqual({
    status: "fail",
    detail: "invalid_statement",
  });
});

test("a signature over another payload type is rejected", () => {
  const body = new TextEncoder().encode(JSON.stringify(announcement(log.key)));
  const payloadType = "application/json";
  const sig = b64(ed25519.sign(pae(payloadType, body), log.secretKey));
  const envelope = {
    payloadType,
    payload: b64(body),
    signatures: [{ keyid: log.key.keyid, sig }],
  } as unknown as DsseEnvelope;
  expect(detail(envelope)).toEqual({ status: "fail", detail: "payload_type" });
});
