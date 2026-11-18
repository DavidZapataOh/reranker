import { readFileSync } from "node:fs";
import { utf8ToBytes } from "@noble/hashes/utils.js";
import { describe, expect, test } from "vitest";
import {
  DSSE_PAYLOAD_TYPE,
  type DsseEnvelope,
  envelopeBytes,
  MAX_PAE_BYTES,
  pae,
} from "../src/format/index";

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

const rfc8785: { vectors: { envelope: DsseEnvelope; jcs: string }[] } = JSON.parse(
  readFileSync(new URL("./fixtures/rfc8785.json", import.meta.url), "utf8"),
);

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
