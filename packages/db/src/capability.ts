import { createHash, randomBytes } from "node:crypto";

// 256 bits: unguessable even with the row id known, and the database keeps only the hash so a
// leaked dump cannot open any link.
const TOKEN_BYTES = 32;

export function createCapabilityToken(): { token: string; hash: Buffer } {
  const token = randomBytes(TOKEN_BYTES).toString("base64url");
  return { token, hash: hashCapabilityToken(token) };
}

export function hashCapabilityToken(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}
