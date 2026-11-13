import { createHash } from "node:crypto";
import { expect, test } from "vitest";
import { createCapabilityToken, hashCapabilityToken } from "./capability";

test("capability token: 43 base64url chars, hash = sha256(token), 1000 tokens unique", () => {
  const { token, hash } = createCapabilityToken();
  expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(Buffer.from(token, "base64url")).toHaveLength(32);
  expect(hash).toHaveLength(32);
  expect(hash.equals(createHash("sha256").update(token).digest())).toBe(true);
  expect(hashCapabilityToken(token).equals(hash)).toBe(true);
  const tokens = new Set(Array.from({ length: 1000 }, () => createCapabilityToken().token));
  expect(tokens.size).toBe(1000);
});
