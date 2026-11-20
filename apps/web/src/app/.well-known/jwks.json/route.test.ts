import { KEYS_BY_ENV, TRUSTED_KEYS } from "@reranker/verify/trust";
import { expect, test } from "vitest";
import { GET } from "./route";

test("jwks serves exactly the production keys as OKP Ed25519 with custody metadata", async () => {
  const response = GET();
  expect(response.headers.get("content-type")).toBe("application/jwk-set+json");
  expect(response.headers.get("access-control-allow-origin")).toBe("*");
  const body = (await response.json()) as { keys: Record<string, unknown>[] };

  expect(TRUSTED_KEYS.length).toBeGreaterThan(0);
  expect(body.keys.map((k) => k.kid)).toEqual(TRUSTED_KEYS.map((k) => k.keyid));
  for (const [i, key] of TRUSTED_KEYS.entries()) {
    expect(body.keys[i]).toEqual({
      kty: "OKP",
      crv: "Ed25519",
      alg: "Ed25519",
      kid: key.keyid,
      x: Buffer.from(key.publicKey, "base64").toString("base64url"),
      use: "sig",
      rr_purpose: key.purpose,
      rr_env: "production",
      rr_custody: "aws-kms-hsm",
      rr_valid_from: key.validFrom,
      rr_valid_to: key.validTo,
      rr_compromised_after: key.compromisedAfter,
    });
  }
});

test("no preview key is ever published", async () => {
  const body = JSON.stringify(await GET().json());
  for (const key of KEYS_BY_ENV.preview) {
    expect(body).not.toContain(key.keyid);
    expect(body).not.toContain(Buffer.from(key.publicKey, "base64").toString("base64url"));
  }
});
