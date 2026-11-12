import { createHash, randomBytes } from "node:crypto";

// 256 bits from the CSPRNG; only the hash is stored, so a database leak exposes no working link.
export function createCapabilityToken(): { token: string; hash: Buffer } {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: hashCapabilityToken(token) };
}

export function hashCapabilityToken(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}
