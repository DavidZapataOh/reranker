import { isIP } from "node:net";
import { InvalidInputError } from "./errors";

const OPAQUE_KEY = /^[a-z0-9:._-]{1,200}$/i;

/**
 * `ops` holds no personal data, so a key built from an address or an email must already be an
 * HMAC. This rejects the shapes a raw value takes; it cannot prove that a key was hashed.
 */
export function assertOpaqueKey(key: string, label = "Bucket key"): void {
  if (!OPAQUE_KEY.test(key)) throw new InvalidInputError(`${label} must be an opaque token`);
  const segments = key.split(":");
  // IPv6 uses colons itself, so every tail of the key is tried as an address.
  for (let i = 0; i < segments.length; i++) {
    if (isIP(segments.slice(i).join(":")) !== 0) {
      throw new InvalidInputError(`${label} must not contain a network address`);
    }
  }
}
