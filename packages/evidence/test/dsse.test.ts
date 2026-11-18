import { createHash } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519.js";
import { DSSE_PAYLOAD_TYPE, envelopeBytes, MAX_PAE_BYTES, pae } from "@reranker/verify/format";
import { describe, expect, test, vi } from "vitest";
import { signEnvelope } from "../src/dsse";
import { SigningKeyMismatchError, StatementTooLargeError } from "../src/errors";
import { localSigner } from "./support/local-signer";

const utf8 = (s: string) => new TextEncoder().encode(s);
const b64decode = (s: string) => new Uint8Array(Buffer.from(s, "base64"));
const sha256Hex = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const header = (bodyLength: number) =>
  `DSSEv1 ${DSSE_PAYLOAD_TYPE.length} ${DSSE_PAYLOAD_TYPE} ${bodyLength} `.length;

describe("signEnvelope", () => {
  test("signs the PAE, not the payload, and the signature verifies with noble in strict mode", async () => {
    const signer = localSigner("rr-capture-test-1-ed25519");
    const { envelope, bytes, sha256 } = await signEnvelope(utf8('{"a":1}'), [signer]);
    const sig = b64decode(envelope.signatures[0]?.sig ?? "");
    expect(envelope.payloadType).toBe(DSSE_PAYLOAD_TYPE);
    expect(b64decode(envelope.payload)).toEqual(utf8('{"a":1}'));
    expect(envelope.signatures[0]?.keyid).toBe("rr-capture-test-1-ed25519");
    expect(
      ed25519.verify(sig, pae(DSSE_PAYLOAD_TYPE, utf8('{"a":1}')), signer.publicKey, {
        zip215: false,
      }),
    ).toBe(true);
    expect(ed25519.verify(sig, utf8('{"a":1}'), signer.publicKey, { zip215: false })).toBe(false);
    expect(sha256).toBe(sha256Hex(bytes));
    expect(bytes).toEqual(envelopeBytes(envelope));
  });

  test("adds one signature per signer, in order", async () => {
    const first = localSigner("rr-log-test-2");
    const second = localSigner("rr-log-test-1");
    const { envelope } = await signEnvelope(utf8("{}"), [first, second]);
    expect(envelope.signatures.map((s) => s.keyid)).toEqual(["rr-log-test-2", "rr-log-test-1"]);
    const message = pae(DSSE_PAYLOAD_TYPE, utf8("{}"));
    envelope.signatures.forEach((s, i) => {
      const signer = [first, second][i];
      expect(ed25519.verify(b64decode(s.sig), message, signer?.publicKey ?? new Uint8Array())).toBe(
        true,
      );
    });
  });

  test("a PAE of exactly 4096 bytes is signed", async () => {
    const body = new Uint8Array(MAX_PAE_BYTES - header(4000));
    const { envelope } = await signEnvelope(body, [localSigner("k")]);
    expect(pae(DSSE_PAYLOAD_TYPE, body).length).toBe(MAX_PAE_BYTES);
    expect(envelope.signatures).toHaveLength(1);
  });

  test("a PAE over 4096 bytes fails closed before signing", async () => {
    const sign = vi.fn();
    const error = await signEnvelope(new Uint8Array(4097), [
      { keyid: "k", publicKey: new Uint8Array(32), sign },
    ]).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StatementTooLargeError);
    expect(error).toMatchObject({ name: "StatementTooLarge", paeBytes: 4097 + header(4097) });
    expect(sign).not.toHaveBeenCalled();
  });

  test("a signature that is not 64 bytes is refused as a key mismatch", async () => {
    const sign = vi.fn(async () => new Uint8Array(65));
    await expect(
      signEnvelope(utf8("{}"), [{ keyid: "k", publicKey: new Uint8Array(32), sign }]),
    ).rejects.toMatchObject({ name: "SigningKeyMismatch", keyid: "k" });
    await expect(
      signEnvelope(utf8("{}"), [{ keyid: "k", publicKey: new Uint8Array(32), sign }]),
    ).rejects.toBeInstanceOf(SigningKeyMismatchError);
  });

  test("an envelope needs at least one signer", async () => {
    await expect(signEnvelope(utf8("{}"), [])).rejects.toBeInstanceOf(TypeError);
  });
});
