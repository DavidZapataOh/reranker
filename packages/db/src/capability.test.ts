import { createHash } from "node:crypto";
import { expect, test } from "vitest";
import { createCapabilityToken, hashCapabilityToken } from "./capability.ts";

test("a token is 32 random bytes in base64url and its hash is sha256 of the token", () => {
  const { token, hash } = createCapabilityToken();
  expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(Buffer.from(token, "base64url")).toHaveLength(32);
  expect(hash).toHaveLength(32);
  expect(hash.equals(createHash("sha256").update(token).digest())).toBe(true);
  expect(hashCapabilityToken(token).equals(hash)).toBe(true);
});

test("1000 tokens are all different", () => {
  const tokens = new Set(Array.from({ length: 1000 }, () => createCapabilityToken().token));
  expect(tokens.size).toBe(1000);
});

test("different tokens never share a hash", () => {
  const a = createCapabilityToken();
  expect(hashCapabilityToken(`${a.token}x`).equals(a.hash)).toBe(false);
});
