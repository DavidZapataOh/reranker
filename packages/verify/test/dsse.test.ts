import { readFileSync } from "node:fs";
import { ed25519 } from "@noble/curves/ed25519.js";
import { hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { describe, expect, test } from "vitest";
import { verifyEd25519, verifyEnvelope } from "../src/dsse";
import {
  DSSE_PAYLOAD_TYPE,
  type DsseEnvelope,
  envelopeBytes,
  MAX_PAE_BYTES,
  pae,
} from "../src/format/index";
import type { TrustedKey } from "../src/trust/keys";

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

const fixture = <T>(name: string): T =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));

const rfc8785 = fixture<{ vectors: { envelope: DsseEnvelope; jcs: string }[] }>("rfc8785.json");

describe("pae", () => {
  test("matches the DSSE protocol example", () => {
    expect(decode(pae("http://example.com/HelloWorld", utf8ToBytes("hello world")))).toBe(
      "DSSEv1 29 http://example.com/HelloWorld 11 hello world",
    );
  });

  test("counts bytes, not characters", () => {
    expect(decode(pae("tipo/ñ", utf8ToBytes("añ")))).toBe("DSSEv1 7 tipo/ñ 3 añ");
  });

  test("keeps the body bytes verbatim", () => {
    const body = new Uint8Array([0, 255, 10, 32]);
    const out = pae(DSSE_PAYLOAD_TYPE, body);
    expect(out.subarray(out.length - body.length)).toEqual(body);
    expect(out.length).toBe(`DSSEv1 28 ${DSSE_PAYLOAD_TYPE} 4 `.length + 4);
  });

  test("the KMS message limit is 4096 bytes", () => expect(MAX_PAE_BYTES).toBe(4096));
});

describe("envelopeBytes", () => {
  test("are JCS: sorted keys, no spaces, stable under reordering", () => {
    const env: DsseEnvelope = {
      signatures: [{ sig: "c2ln", keyid: "k" }],
      payloadType: DSSE_PAYLOAD_TYPE,
      payload: "cGF5",
    };
    expect(decode(envelopeBytes(env))).toBe(
      '{"payload":"cGF5","payloadType":"application/vnd.in-toto+json","signatures":[{"keyid":"k","sig":"c2ln"}]}',
    );
  });

  test.each(rfc8785.vectors)("match the RFC 8785 reference output %#", ({ envelope, jcs }) =>
    expect(decode(envelopeBytes(envelope))).toBe(jcs),
  );

  test.each<[string, unknown]>([
    ["non-ASCII", { payloadType: "á", payload: "", signatures: [] }],
    ["control characters", { payloadType: DSSE_PAYLOAD_TYPE, payload: "\n", signatures: [] }],
    ["a non-string value", { payloadType: DSSE_PAYLOAD_TYPE, payload: 1, signatures: [] }],
    [
      "a non-string keyid",
      { payloadType: DSSE_PAYLOAD_TYPE, payload: "", signatures: [{ keyid: 1, sig: "" }] },
    ],
    [
      "an unknown field",
      { payloadType: DSSE_PAYLOAD_TYPE, payload: "", signatures: [], extra: "" },
    ],
    [
      "an unknown signature field",
      { payloadType: DSSE_PAYLOAD_TYPE, payload: "", signatures: [{ keyid: "k", sig: "", x: "" }] },
    ],
    ["a missing field", { payloadType: DSSE_PAYLOAD_TYPE, signatures: [] }],
    [
      "signatures that are not an array",
      { payloadType: DSSE_PAYLOAD_TYPE, payload: "", signatures: {} },
    ],
    ["a null signature", { payloadType: DSSE_PAYLOAD_TYPE, payload: "", signatures: [null] }],
    ["a non-object", null],
  ])("reject %s", (_, input) => {
    expect(() => envelopeBytes(input as DsseEnvelope)).toThrow(TypeError);
  });
});

const rfc8032 =
  fixture<{ name: string; pub: string; msg: string; sig: string }[]>("rfc8032-7.1.json");

// C2SP/wycheproof testvectors_v1/ed25519_test.json at 65ca494727a52944c204441c860b039e6786b99b,
// without the DER, PEM and JWK copies of each public key.
const wycheproof = fixture<{
  testGroups: {
    publicKey: { pk: string };
    tests: { tcId: number; flags: string[]; msg: string; sig: string; result: string }[];
  }[];
}>("wycheproof-ed25519.json").testGroups.flatMap((g) =>
  g.tests.map((t) => ({ ...t, pk: g.publicKey.pk })),
);

describe("verifyEd25519", () => {
  test.each(rfc8032)("RFC 8032 §7.1 $name verifies", ({ pub, msg, sig }) =>
    expect(verifyEd25519(hexToBytes(pub), hexToBytes(msg), hexToBytes(sig))).toBe(true),
  );

  test("the Wycheproof file has every vector", () => expect(wycheproof).toHaveLength(210));

  // "acceptable" vectors are the ones conforming verifiers may disagree on.
  test.each(wycheproof.filter((t) => t.result !== "acceptable"))(
    "Wycheproof $tcId is $result ($flags)",
    (t) =>
      expect(verifyEd25519(hexToBytes(t.pk), hexToBytes(t.msg), hexToBytes(t.sig))).toBe(
        t.result === "valid",
      ),
  );
});

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
const unb64 = (text: string) => new Uint8Array(Buffer.from(text, "base64"));

const secretKey = hexToBytes("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60");
const testKey: TrustedKey = {
  keyid: "rr-capture-test-1",
  purpose: "capture",
  env: "preview",
  alg: "Ed25519",
  publicKey: b64(ed25519.getPublicKey(secretKey)),
  custody: "gcp-kms-software",
  validFrom: "2026-01-01T00:00:00Z",
  validTo: null,
  compromisedAfter: null,
};
const statement = fixture<unknown>("statement.capture.json");
const statementBytes = utf8ToBytes(JSON.stringify(statement));

function sign(payload: Uint8Array, payloadType: string = DSSE_PAYLOAD_TYPE): DsseEnvelope {
  return {
    payloadType: payloadType as typeof DSSE_PAYLOAD_TYPE,
    payload: b64(payload),
    signatures: [
      { keyid: testKey.keyid, sig: b64(ed25519.sign(pae(payloadType, payload), secretKey)) },
    ],
  };
}

const signedEnvelope = sign(statementBytes);

const withSig = (envelope: DsseEnvelope, sig: string): DsseEnvelope => ({
  ...envelope,
  signatures: [{ keyid: testKey.keyid, sig }],
});

const withKeyid = (envelope: DsseEnvelope, keyid: string): DsseEnvelope => ({
  ...envelope,
  signatures: envelope.signatures.map((s) => ({ ...s, keyid })),
});

function flipPayloadByte(envelope: DsseEnvelope): DsseEnvelope {
  const payload = unb64(envelope.payload);
  payload[10] = (payload[10] ?? 0) ^ 0x01;
  return { ...envelope, payload: b64(payload) };
}

// Order of the edwards25519 prime subgroup.
const L = 2n ** 252n + 27742317777372353535851937790883648493n;

/** Re-encodes S as S + L: the same scalar mod L, but a non-canonical encoding. */
function addOrderToS(envelope: DsseEnvelope): DsseEnvelope {
  const sig = unb64(envelope.signatures[0]?.sig ?? "");
  let s = 0n;
  for (let i = 63; i >= 32; i--) s = s * 256n + BigInt(sig[i] ?? 0);
  s += L;
  for (let i = 32; i < 64; i++) {
    sig[i] = Number(s % 256n);
    s /= 256n;
  }
  return withSig(envelope, b64(sig));
}

describe("verifyEnvelope", () => {
  test("an envelope signed by a registry key passes and returns the statement", () => {
    const r = verifyEnvelope(signedEnvelope, [testKey]);
    expect(r.check.status).toBe("pass");
    expect(r.keyid).toBe(testKey.keyid);
    expect(r.statement).toEqual(statement);
  });

  test("one changed payload byte fails and returns no statement", () => {
    expect(verifyEnvelope(flipPayloadByte(signedEnvelope), [testKey])).toEqual({
      check: { status: "fail", detail: "bad_signature" },
      keyid: null,
      statement: null,
    });
  });

  // The signature is valid for testKey: only the keyid points elsewhere.
  test("an unknown keyid fails without trying other keys", () =>
    expect(verifyEnvelope(withKeyid(signedEnvelope, "other"), [testKey]).check).toMatchObject({
      status: "fail",
      detail: "unknown_key",
    }));

  test("a log key cannot sign a capture statement", () =>
    expect(verifyEnvelope(signedEnvelope, [{ ...testKey, purpose: "log" }]).check).toMatchObject({
      status: "fail",
      detail: "unknown_key",
    }));

  test("a non-canonical signature encoding (S >= L) fails in strict mode", () => {
    const malleable = addOrderToS(signedEnvelope);
    expect(malleable.signatures[0]?.sig).not.toBe(signedEnvelope.signatures[0]?.sig);
    expect(verifyEnvelope(malleable, [testKey]).check).toMatchObject({
      status: "fail",
      detail: "bad_signature",
    });
  });

  test("during a rotation, one valid known signature is enough", () => {
    const valid = signedEnvelope.signatures[0];
    if (!valid) throw new Error("fixture has no signature");
    const r = verifyEnvelope(
      {
        ...signedEnvelope,
        signatures: [
          { ...valid, keyid: "retired" },
          { keyid: testKey.keyid, sig: b64(new Uint8Array(64)) },
          valid,
        ],
      },
      [testKey],
    );
    expect(r.check.status).toBe("pass");
    expect(r.keyid).toBe(testKey.keyid);
  });

  test("a validly signed payload of another type fails", () =>
    expect(verifyEnvelope(sign(statementBytes, "application/json"), [testKey])).toEqual({
      check: { status: "fail", detail: "payload_type" },
      keyid: testKey.keyid,
      statement: null,
    }));

  test.each([
    ["an object that is not a capture statement", "{}"],
    ["bytes that are not JSON", "not json"],
  ])("a validly signed payload with %s fails", (_, payload) =>
    expect(verifyEnvelope(sign(utf8ToBytes(payload)), [testKey])).toEqual({
      check: { status: "fail", detail: "invalid_statement" },
      keyid: testKey.keyid,
      statement: null,
    }),
  );

  test.each<[string, (e: DsseEnvelope) => DsseEnvelope, string]>([
    ["a payload that is not base64", (e) => ({ ...e, payload: "%%%" }), "malformed"],
    ["a signature that is not base64", (e) => withSig(e, "not base64!"), "bad_signature"],
    ["a truncated signature", (e) => withSig(e, b64(new Uint8Array(63))), "bad_signature"],
    ["no signatures", (e) => ({ ...e, signatures: [] }), "unknown_key"],
  ])("%s fails without throwing", (_, mutate, detail) =>
    expect(verifyEnvelope(mutate(signedEnvelope), [testKey]).check).toEqual({
      status: "fail",
      detail,
    }),
  );
});
