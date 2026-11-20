import { endPools, withSystem } from "@reranker/db";
import { signingKeys } from "@reranker/db/schema";
import { LOG_ORIGIN } from "@reranker/verify/format";
import { KEYS_BY_ENV, noteVerifierKey, TRUSTED_KEYS } from "@reranker/verify/trust";
import { afterAll, expect, test } from "vitest";
import { KEY_RECORDS } from "../scripts/provision-dns";
import { GET as jwks } from "../src/app/.well-known/jwks.json/route";
import { GET as logKeys } from "../src/app/.well-known/reranker-log-keys/route";

// A verifier trusts a key only when every copy agrees: the registry pinned in @reranker/verify,
// the database record of keys that ever signed, the JWKS and the `_rr-keys` TXT records.

afterAll(() => endPools());

const registry = [...KEYS_BY_ENV.production, ...KEYS_BY_ENV.preview].sort((a, b) =>
  a.keyid.localeCompare(b.keyid),
);
const raw = (base64: string) => Uint8Array.from(Buffer.from(base64, "base64"));

test("signing_keys equals the pinned registry for every environment", async () => {
  const rows = await withSystem(
    "evidence.keys_registry_test",
    (tx) => tx.select().from(signingKeys),
    { readOnly: true },
  );
  const byKeyid = (a: { keyid: string }, b: { keyid: string }) => a.keyid.localeCompare(b.keyid);
  expect(
    rows.sort(byKeyid).map((row) => ({
      keyid: row.keyid,
      purpose: row.purpose,
      env: row.env,
      publicKey: row.publicKey.toString("base64"),
      custody: row.custody,
      validFrom: row.validFrom.toISOString(),
      validTo: row.validTo?.toISOString() ?? null,
      compromisedAfter: row.compromisedAfter?.toISOString() ?? null,
      noteVkey: row.noteVkey,
    })),
  ).toEqual(
    registry.map(({ alg: _alg, ...key }) => ({
      ...key,
      noteVkey:
        key.purpose === "log" && key.env === "production"
          ? noteVerifierKey(LOG_ORIGIN, raw(key.publicKey))
          : null,
    })),
  );
});

test("the JWKS, the TXT records and the log verifier keys publish exactly the production keys", async () => {
  const production = KEYS_BY_ENV.production;
  expect(TRUSTED_KEYS).toEqual(production);

  const { keys } = (await jwks().json()) as { keys: { kid: string; x: string }[] };
  expect(keys.map(({ kid, x }) => ({ kid, x }))).toEqual(
    production.map((key) => ({
      kid: key.keyid,
      x: Buffer.from(key.publicKey, "base64").toString("base64url"),
    })),
  );

  expect(KEY_RECORDS.map((record) => [record.name, record.content])).toEqual(
    production.map((key) => ["_rr-keys.reranker.co", `"${key.keyid}=${key.publicKey}"`]),
  );

  expect(await logKeys().text()).toBe(
    production
      .filter((key) => key.purpose === "log")
      .map((key) => `${noteVerifierKey(LOG_ORIGIN, raw(key.publicKey))}\n`)
      .join(""),
  );
});
