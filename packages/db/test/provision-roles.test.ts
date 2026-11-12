import { describe, expect, test } from "vitest";
import { parseLoginPasswords, passwordEntropyBits } from "../scripts/provision-roles.ts";

const strong = "f3a9c1e07b52d84e6a1f0c9b3d7e2a58";

describe("parseLoginPasswords", () => {
  test("accepts both logins with strong passwords", () => {
    const raw = JSON.stringify({ reranker_app: strong, reranker_system: `${strong}x` });
    expect(parseLoginPasswords(raw)).toEqual({
      reranker_app: strong,
      reranker_system: `${strong}x`,
    });
  });

  test("rejects a missing login naming it", () => {
    expect(() => parseLoginPasswords(JSON.stringify({ reranker_app: strong }))).toThrow(
      /reranker_system/,
    );
  });

  test("rejects an unknown login", () => {
    const raw = JSON.stringify({ reranker_app: strong, reranker_system: strong, extra: strong });
    expect(() => parseLoginPasswords(raw)).toThrow(/DB_LOGIN_PASSWORDS is invalid/);
  });

  test("rejects a password under 60 bits of entropy naming the login", () => {
    const raw = JSON.stringify({ reranker_app: strong, reranker_system: "aaaaaaaa" });
    expect(() => parseLoginPasswords(raw)).toThrow(/reranker_system password .* entropy/);
  });

  test("rejects a missing variable and malformed JSON without echoing it", () => {
    expect(() => parseLoginPasswords(undefined)).toThrow(/DB_LOGIN_PASSWORDS/);
    expect(() => parseLoginPasswords("{secret")).toThrow(
      "DB_LOGIN_PASSWORDS must be a JSON object of login to password",
    );
  });
});

test("entropy is length times log2 of the character classes used", () => {
  expect(passwordEntropyBits("")).toBe(0);
  expect(passwordEntropyBits("aaaaaaaa")).toBeCloseTo(8 * Math.log2(26));
  expect(passwordEntropyBits("aA1!")).toBeCloseTo(4 * Math.log2(95));
  // 48 hex characters, as CI generates with `openssl rand -hex 24`.
  expect(passwordEntropyBits("0123456789abcdef".repeat(3))).toBeGreaterThan(200);
});
