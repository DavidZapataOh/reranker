import { createHash } from "node:crypto";
import { expect, test } from "vitest";
import { createCapabilityToken, hashCapabilityToken } from "./capability.ts";

test("a capability token is 43 base64url chars and its hash is sha256 of the token", () => {
  const { token, hash } = createCapabilityToken();
  expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(hash).toHaveLength(32);
  expect(hash.equals(createHash("sha256").update(token).digest())).toBe(true);
  expect(hashCapabilityToken(token).equals(hash)).toBe(true);
});

test("1,000 tokens are all distinct", () => {
  const tokens = new Set(Array.from({ length: 1000 }, () => createCapabilityToken().token));
  expect(tokens.size).toBe(1000);
});
