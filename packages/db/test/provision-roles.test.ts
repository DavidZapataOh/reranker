import { expect, test } from "vitest";
import { parseLoginPasswords, passwordEntropyBits } from "../scripts/provision-roles.ts";

const strong = "f3a9c1e07b5d2e4a8c6b1d3f5e7a9c0b2d4f6e8a1c3b5d7";

test("accepts both logins with strong passwords", () => {
  expect(
    parseLoginPasswords(JSON.stringify({ reranker_app: strong, reranker_system: `${strong}x` })),
  ).toEqual({ reranker_app: strong, reranker_system: `${strong}x` });
});

test("rejects a missing login, naming it", () => {
  expect(() => parseLoginPasswords(JSON.stringify({ reranker_app: strong }))).toThrow(
    /reranker_system/,
  );
});

test("rejects a password under 60 bits of entropy without echoing it", () => {
  expect(() =>
    parseLoginPasswords(JSON.stringify({ reranker_app: "aaaaaaaa", reranker_system: strong })),
  ).toThrow(
    expect.objectContaining({
      message: expect.stringMatching(/^(?!.*aaaaaaaa).*entropy/),
    }),
  );
});

test.each([
  ["not json", "{"],
  ["an array", "[]"],
  ["missing", undefined],
  ["unknown login", JSON.stringify({ reranker_app: strong, reranker_system: strong, x: strong })],
  ["non-string", JSON.stringify({ reranker_app: 1, reranker_system: strong })],
  ["spaces", JSON.stringify({ reranker_app: `${strong} x`, reranker_system: strong })],
])("rejects %s", (_label, raw) => {
  expect(() => parseLoginPasswords(raw)).toThrow(/DB_LOGIN_PASSWORDS/);
});

test("entropy counts length times the bits of the character pool", () => {
  expect(passwordEntropyBits("")).toBe(0);
  expect(passwordEntropyBits("abcd")).toBeCloseTo(4 * Math.log2(26));
  expect(passwordEntropyBits("aB3!")).toBeCloseTo(4 * Math.log2(95));
  // What the CI action generates: openssl rand -hex 24.
  expect(passwordEntropyBits(strong.slice(0, 48))).toBeGreaterThan(60);
});
