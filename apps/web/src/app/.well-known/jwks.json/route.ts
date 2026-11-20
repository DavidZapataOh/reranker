import { TRUSTED_KEYS } from "@reranker/verify/trust";

export const dynamic = "force-static";

const toBase64Url = (base64: string) =>
  base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/**
 * The production signing keys as an RFC 7517 key set (Ed25519 per RFC 8037), with the custody
 * and validity a verifier checks. It mirrors the registry pinned in @reranker/verify, so a key
 * that differs here, in the bundle or in the `_rr-keys` TXT record exposes tampering.
 */
export function GET(): Response {
  const keys = TRUSTED_KEYS.map((key) => ({
    kty: "OKP",
    crv: "Ed25519",
    alg: "Ed25519",
    kid: key.keyid,
    x: toBase64Url(key.publicKey),
    use: "sig",
    rr_purpose: key.purpose,
    rr_env: key.env,
    rr_custody: key.custody,
    rr_valid_from: key.validFrom,
    rr_valid_to: key.validTo,
    rr_compromised_after: key.compromisedAfter,
  }));
  return Response.json(
    { keys },
    {
      headers: {
        "Content-Type": "application/jwk-set+json",
        // Verifiers on other origins compare this set with the bundle and DNS.
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "public, max-age=300, s-maxage=3600",
      },
    },
  );
}
