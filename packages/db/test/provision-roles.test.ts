import { expect, test } from "vitest";
import { parseLoginPasswords, passwordEntropyBits } from "../scripts/provision-roles.ts";

const STRONG = "f3c1a9e04b7d52c86e1f0a9b3c4d5e6f7a8b9c0d1e2f3a4b";

test("accepts one strong password per login", () => {
  expect(
    parseLoginPasswords(JSON.stringify({ reranker_app: STRONG, reranker_system: `${STRONG}x` })),
  ).toEqual({ reranker_app: STRONG, reranker_system: `${STRONG}x` });
});

test.each([
  [undefined, /DB_LOGIN_PASSWORDS/],
  ["not json", /JSON/],
  ["[]", /object/],
  [JSON.stringify({ reranker_app: STRONG }), /reranker_system/],
  [JSON.stringify({ reranker_app: STRONG, reranker_system: 42 }), /reranker_system/],
  [
    JSON.stringify({ reranker_app: STRONG, reranker_system: STRONG, reranker_owner: STRONG }),
    /reranker_owner/,
  ],
  [JSON.stringify({ reranker_app: "aaaaaaaa", reranker_system: STRONG }), /reranker_app.*entropy/],
])("rejects %s", (input, message) => {
  expect(() => parseLoginPasswords(input)).toThrow(message);
});

test("never echoes a password in the error", () => {
  expect(() =>
    parseLoginPasswords(JSON.stringify({ reranker_app: "weakpass", reranker_system: STRONG })),
  ).not.toThrow(/weakpass/);
});

test("entropy is length times log2 of the character classes in use", () => {
  expect(passwordEntropyBits("aaaaaaaa")).toBeCloseTo(8 * Math.log2(26));
  expect(passwordEntropyBits("aA1!")).toBeCloseTo(4 * Math.log2(26 + 26 + 10 + 33));
  expect(passwordEntropyBits(STRONG)).toBeGreaterThanOrEqual(60);
  expect(passwordEntropyBits("")).toBe(0);
});
