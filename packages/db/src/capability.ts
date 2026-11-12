import { createHash, randomBytes } from "node:crypto";

const TOKEN_BYTES = 32;

/**
 * A secret link token (256 random bits) and the sha256 the database keeps instead of it,
 * so a leaked database never exposes working links.
 */
export function createCapabilityToken(): { token: string; hash: Buffer } {
  const token = randomBytes(TOKEN_BYTES).toString("base64url");
  return { token, hash: hashCapabilityToken(token) };
}

export function hashCapabilityToken(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}
