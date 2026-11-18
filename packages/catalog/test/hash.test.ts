// Vectors from RFC 8785 §3.2.2, §3.2.3 and Appendix B: https://www.rfc-editor.org/rfc/rfc8785
import { describe, expect, test } from "vitest";
import { contentHash, intentSetId, jcs, promptSha256, sha256Hex, variantId } from "../src/hash";

const ieee = (hex: string) => Buffer.from(hex, "hex").readDoubleBE(0);
const utf8 = (bytes: Uint8Array) => Buffer.from(bytes).toString("utf8");

const numberVectors: [string, number, string][] = [
  ["zero", ieee("0000000000000000"), "0"],
  ["minus zero", ieee("8000000000000000"), "0"],
  ["min pos number", ieee("0000000000000001"), "5e-324"],
  ["min neg number", ieee("8000000000000001"), "-5e-324"],
  ["max pos number", ieee("7fefffffffffffff"), "1.7976931348623157e+308"],
  ["max neg number", ieee("ffefffffffffffff"), "-1.7976931348623157e+308"],
  ["max pos int", ieee("4340000000000000"), "9007199254740992"],
  ["max neg int", ieee("c340000000000000"), "-9007199254740992"],
  ["~2**68", ieee("4430000000000000"), "295147905179352830000"],
  ["44b52d02c7e14af5", ieee("44b52d02c7e14af5"), "9.999999999999997e+22"],
  ["44b52d02c7e14af6", ieee("44b52d02c7e14af6"), "1e+23"],
  ["44b52d02c7e14af7", ieee("44b52d02c7e14af7"), "1.0000000000000001e+23"],
  ["444b1ae4d6e2ef4e", ieee("444b1ae4d6e2ef4e"), "999999999999999700000"],
  ["444b1ae4d6e2ef4f", ieee("444b1ae4d6e2ef4f"), "999999999999999900000"],
  ["444b1ae4d6e2ef50", ieee("444b1ae4d6e2ef50"), "1e+21"],
  ["3eb0c6f7a0b5ed8c", ieee("3eb0c6f7a0b5ed8c"), "9.999999999999997e-7"],
  ["3eb0c6f7a0b5ed8d", ieee("3eb0c6f7a0b5ed8d"), "0.000001"],
  ["41b3de4355555553", ieee("41b3de4355555553"), "333333333.3333332"],
  ["41b3de4355555554", ieee("41b3de4355555554"), "333333333.33333325"],
  ["41b3de4355555555", ieee("41b3de4355555555"), "333333333.3333333"],
  ["41b3de4355555556", ieee("41b3de4355555556"), "333333333.3333334"],
  ["41b3de4355555557", ieee("41b3de4355555557"), "333333333.33333343"],
  ["becbf647612f3696", ieee("becbf647612f3696"), "-0.0000033333333333333333"],
  ["round to even", ieee("43143ff3c1cb0959"), "1424953923781206.2"],
];

// "%xxxx" stands for the JSON escape backslash-u-xxxx, so the vectors read as printed in the RFC.
const rfcJson = (text: string) => text.replaceAll("%", `${String.fromCharCode(92)}u`);
const cp = (code: number) => String.fromCodePoint(code);

const rfc8785Vectors: [string, unknown, string][] = [
  ...numberVectors,
  [
    "§3.2.3 primitives sample",
    JSON.parse(
      rfcJson(
        String.raw`{"numbers":[333333333.33333329,1E30,4.50,2e-3,0.000000000000000000000000001],"string":"%20ac$%000F%000aA'%0042%0022%005c\\\"\/","literals":[null,true,false]}`,
      ),
    ),
    rfcJson(
      String.raw`{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"string":"${cp(0x20ac)}$%000f\nA'B\"\\\\\"/"}`,
    ),
  ],
  [
    "§3.2.3 property sorting",
    JSON.parse(
      rfcJson(
        String.raw`{"%20ac":"Euro Sign","\r":"Carriage Return","%fb33":"Hebrew Letter Dalet With Dagesh","1":"One","%d83d%de00":"Emoji: Grinning Face","%0080":"Control","%00f6":"Latin Small Letter O With Diaeresis"}`,
      ),
    ),
    String.raw`{"\r":"Carriage Return","1":"One","${cp(0x80)}":"Control","${cp(0xf6)}":"Latin Small Letter O With Diaeresis","${cp(0x20ac)}":"Euro Sign","${cp(0x1f600)}":"Emoji: Grinning Face","${cp(0xfb33)}":"Hebrew Letter Dalet With Dagesh"}`,
  ],
];

describe("jcs", () => {
  test.each(rfc8785Vectors)("JCS matches RFC 8785 vector %s", (_, input, expected) =>
    expect(utf8(jcs(input))).toBe(expected),
  );

  test.each([
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["a lone surrogate", "\udead"],
    ["undefined", undefined],
  ])("rejects %s", (_, value) => expect(() => jcs(value)).toThrow());
});

describe("hashes", () => {
  test("sha256 hex matches the FIPS 180-2 abc vector for strings and bytes", () => {
    const abc = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
    expect(sha256Hex("abc")).toBe(abc);
    expect(sha256Hex(new TextEncoder().encode("abc"))).toBe(abc);
  });

  test("content hash ignores key order and whitespace", () =>
    expect(contentHash(JSON.parse('{"b":1,"a":[1,2]}'))).toBe(contentHash({ a: [1, 2], b: 1 })));

  test("content hash is the sha256 of the canonical bytes", () =>
    expect(contentHash({ b: 1, a: [1, 2] })).toBe(sha256Hex('{"a":[1,2],"b":1}')));

  test("prompt sha256 hashes the exact text sent", () => {
    const text = "mejor clínica dental en Medellín";
    expect(promptSha256(text)).toBe(sha256Hex(text));
    expect(promptSha256("a ")).not.toBe(promptSha256("a"));
  });
});

describe("ids", () => {
  const base = {
    intentId: "dental_clinic.best_clinic",
    paraphraseId: "p01",
    personaId: null,
    geoKey: "co-c1003654",
  };

  test("variant id is deterministic and depends on the place", () => {
    expect(variantId(base)).toMatch(/^pv_[0-9a-f]{16}$/);
    expect(variantId(base)).toBe(variantId({ ...base }));
    expect(variantId({ ...base, geoKey: "co-c1003659" })).not.toBe(variantId(base));
  });

  test("variant id is the first 16 hex of the canonical tuple hash", () =>
    expect(variantId(base)).toBe(`pv_${contentHash({ ...base }).slice(0, 16)}`));

  test("variant id tells a persona apart from no persona", () =>
    expect(variantId({ ...base, personaId: "dental_clinic.parent" })).not.toBe(variantId(base)));

  test("intent set id is is_ plus 16 hex of the content hash", () =>
    expect(intentSetId("a".repeat(64))).toBe(`is_${"a".repeat(16)}`));

  test.each(["", "a".repeat(63), "A".repeat(64), "g".repeat(64)])(
    "intent set id rejects a malformed content hash %#",
    (hash) => expect(() => intentSetId(hash)).toThrow(),
  );
});
