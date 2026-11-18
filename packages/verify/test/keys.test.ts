import { bytesToHex } from "@noble/hashes/utils.js";
import { expect, test } from "vitest";
import { KEYS_BY_ENV, noteKeyId, noteVerifierKey, TRUSTED_KEYS } from "../src/trust/keys";

// Example verifier key from c2sp.org/signed-note (commit b2dd9892338af7009733a4575a6da05811ffae6c).
const exampleName = "example.com/foo";
const exampleVkey = "example.com/foo+530d903a+AekyeRrm56hApGFkyQR4ZCbV54Id2LKaANYcrnKv3U2k";
const examplePub = Uint8Array.from(atob("AekyeRrm56hApGFkyQR4ZCbV54Id2LKaANYcrnKv3U2k"), (c) =>
  c.charCodeAt(0),
).subarray(1);

test("note key id follows signed-note", () => {
  expect(bytesToHex(noteKeyId(exampleName, examplePub))).toBe("530d903a");
});

test("note verifier key follows signed-note", () => {
  expect(noteVerifierKey(exampleName, examplePub)).toBe(exampleVkey);
});

test("note helpers reject keys that are not 32-byte Ed25519 keys", () => {
  expect(() => noteKeyId(exampleName, new Uint8Array(33))).toThrow(TypeError);
  expect(() => noteVerifierKey(exampleName, new Uint8Array(31))).toThrow(TypeError);
});

test("note key names cannot contain a plus sign or whitespace", () => {
  expect(() => noteVerifierKey("a+b", examplePub)).toThrow(TypeError);
  expect(() => noteVerifierKey("a b", examplePub)).toThrow(TypeError);
  expect(() => noteVerifierKey("", examplePub)).toThrow(TypeError);
});

test("production registry never contains preview keys and keyids are unique", () => {
  expect(TRUSTED_KEYS).toBe(KEYS_BY_ENV.production);
  expect(TRUSTED_KEYS.every((k) => k.env === "production")).toBe(true);
  expect(KEYS_BY_ENV.preview.every((k) => k.env === "preview")).toBe(true);
  const all = [...KEYS_BY_ENV.production, ...KEYS_BY_ENV.preview];
  expect(new Set(all.map((k) => k.keyid)).size).toBe(all.length);
});

test("every registered key is a 32-byte Ed25519 public key", () => {
  for (const key of [...KEYS_BY_ENV.production, ...KEYS_BY_ENV.preview]) {
    expect(atob(key.publicKey)).toHaveLength(32);
  }
});
