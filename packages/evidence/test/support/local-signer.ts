import { generateKeyPairSync, sign } from "node:crypto";
import type { Signer } from "../../src/signer";

const SPKI_ED25519_PREFIX_BYTES = 12;

/** In-process Ed25519 key for tests; production keys never leave AWS KMS. */
export function localSigner(keyid: string): Signer {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ format: "der", type: "spki" });
  return {
    keyid,
    publicKey: new Uint8Array(spki.subarray(SPKI_ED25519_PREFIX_BYTES)),
    sign: async (message) => new Uint8Array(sign(null, message, privateKey)),
  };
}
