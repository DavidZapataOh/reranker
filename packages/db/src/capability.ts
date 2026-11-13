import { createHash, randomBytes } from "node:crypto";

// Only the hash is stored, so a leaked database row cannot be replayed as a link or cookie.
export function hashCapabilityToken(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}

export function createCapabilityToken(): { token: string; hash: Buffer } {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: hashCapabilityToken(token) };
}
