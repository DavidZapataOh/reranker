import { ed25519 } from "@noble/curves/ed25519.js";
import { describe, expect, test, vi } from "vitest";
import { acceptsKeyAt, checkKeyConsistency } from "../src/keys-consistency";
import type { TrustedKey } from "../src/trust/keys";

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
const b64url = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");

const publicKey = ed25519.getPublicKey(ed25519.utils.randomSecretKey());
const otherKey = ed25519.getPublicKey(ed25519.utils.randomSecretKey());
const logPublicKey = ed25519.getPublicKey(ed25519.utils.randomSecretKey());

const key: TrustedKey = {
  keyid: "rr-capture-2026-1-ed25519",
  purpose: "capture",
  env: "production",
  alg: "Ed25519",
  publicKey: b64(publicKey),
  custody: "aws-kms-hsm",
  validFrom: "2026-11-01T00:00:00Z",
  validTo: null,
  compromisedAfter: null,
};
const kid = key.keyid;

const pinned = vi.hoisted((): TrustedKey[] => []);
vi.mock("../src/trust/keys", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/trust/keys")>()),
  TRUSTED_KEYS: pinned,
}));
pinned.push(key);

const JWKS = "https://reranker.co/.well-known/jwks.json";
const GOOGLE = "https://dns.google/resolve?name=_rr-keys.reranker.co&type=TXT";
const CLOUDFLARE = "https://cloudflare-dns.com/dns-query?name=_rr-keys.reranker.co&type=TXT";

type Reply = Response | "hang" | "error";

const jwks = (x: Uint8Array) =>
  Response.json({
    keys: [
      { kty: "OKP", crv: "Ed25519", alg: "Ed25519", kid: "rr-log-2026-1", x: b64url(logPublicKey) },
      { kty: "OKP", crv: "Ed25519", alg: "Ed25519", kid, x: b64url(x), use: "sig" },
    ],
  });

// Google's JSON API joins the character-strings of a TXT record; Cloudflare's returns them in
// presentation format, quoted and space-separated. Both shapes were recorded from the live APIs.
const txtRecords = (texts: string[], quoted: boolean) => ({
  Status: 0,
  Answer: texts.map((text) => ({
    name: "_rr-keys.reranker.co.",
    type: 16,
    TTL: 300,
    data: quoted ? `"${text}"` : text,
  })),
});
const google = (texts: string[]) => Response.json(txtRecords(texts, false));
const cloudflare = (texts: string[]) => Response.json(txtRecords(texts, true));

const records = (x: Uint8Array) => [`rr-log-2026-1=${b64(logPublicKey)}`, `${kid}=${b64(x)}`];

function fakeFetch(replies: Record<string, Reply>) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const reply = replies[url];
    if (!reply) throw new TypeError(`unexpected request to ${url}`);
    if (reply === "error") throw new TypeError("network error");
    if (reply === "hang") {
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });
    }
    return reply.clone();
  }) as typeof fetch;
  return Object.assign(impl, { calls });
}

const agreeing = () =>
  fakeFetch({
    [JWKS]: jwks(publicKey),
    [GOOGLE]: google(records(publicKey)),
    [CLOUDFLARE]: cloudflare(records(publicKey)),
  });

describe("checkKeyConsistency", () => {
  test("pinned + JWKS + TXT agree → 3 of 3", async () => {
    expect(await checkKeyConsistency(kid, { fetch: agreeing() })).toEqual({
      status: "pass",
      matches: 3,
      of: 3,
    });
  });

  test("asks Cloudflare for JSON and runs the three lookups in parallel", async () => {
    const fetch = agreeing();
    await checkKeyConsistency(kid, { fetch });
    expect(fetch.calls.map((c) => c.url).sort()).toEqual([CLOUDFLARE, GOOGLE, JWKS]);
    const cf = fetch.calls.find((c) => c.url === CLOUDFLARE);
    expect(new Headers(cf?.init?.headers).get("accept")).toBe("application/dns-json");
    expect(fetch.calls.every((c) => c.init?.signal instanceof AbortSignal)).toBe(true);
  });

  test("JWKS disagrees → fail with matches 2 and doh_mismatch detail", async () => {
    const fetch = fakeFetch({
      [JWKS]: jwks(otherKey),
      [GOOGLE]: google(records(publicKey)),
      [CLOUDFLARE]: cloudflare(records(publicKey)),
    });
    expect(await checkKeyConsistency(kid, { fetch })).toEqual({
      status: "fail",
      detail: "doh_mismatch",
      matches: 2,
      of: 3,
    });
  });

  test("a JWKS without the key is a disagreement, not an outage", async () => {
    const fetch = fakeFetch({
      [JWKS]: Response.json({ keys: [] }),
      [GOOGLE]: google(records(publicKey)),
      [CLOUDFLARE]: cloudflare(records(publicKey)),
    });
    expect(await checkKeyConsistency(kid, { fetch })).toMatchObject({ status: "fail", matches: 2 });
  });

  test("a JWKS entry for the kid that is not an Ed25519 OKP key disagrees", async () => {
    const fetch = fakeFetch({
      [JWKS]: Response.json({ keys: [{ kty: "EC", crv: "P-256", kid, x: b64url(publicKey) }] }),
      [GOOGLE]: google(records(publicKey)),
      [CLOUDFLARE]: cloudflare(records(publicKey)),
    });
    expect(await checkKeyConsistency(kid, { fetch })).toMatchObject({ status: "fail", matches: 2 });
  });

  test("one resolver disagreeing with the other is a mismatch even if one agrees", async () => {
    const fetch = fakeFetch({
      [JWKS]: jwks(publicKey),
      [GOOGLE]: google(records(publicKey)),
      [CLOUDFLARE]: cloudflare(records(otherKey)),
    });
    expect(await checkKeyConsistency(kid, { fetch })).toEqual({
      status: "fail",
      detail: "doh_mismatch",
      matches: 2,
      of: 3,
    });
  });

  test("two TXT records for the same key with different values disagree", async () => {
    const both = [...records(publicKey), `${kid}=${b64(otherKey)}`];
    const fetch = fakeFetch({
      [JWKS]: jwks(publicKey),
      [GOOGLE]: google(both),
      [CLOUDFLARE]: cloudflare(both),
    });
    expect(await checkKeyConsistency(kid, { fetch })).toMatchObject({ status: "fail", matches: 2 });
  });

  test("a name that does not exist (NXDOMAIN) disagrees", async () => {
    const nx = () => Response.json({ Status: 3, Authority: [] });
    const fetch = fakeFetch({ [JWKS]: jwks(publicKey), [GOOGLE]: nx(), [CLOUDFLARE]: nx() });
    expect(await checkKeyConsistency(kid, { fetch })).toMatchObject({ status: "fail", matches: 2 });
  });

  test("one resolver down still counts the TXT place when the other agrees", async () => {
    const fetch = fakeFetch({
      [JWKS]: jwks(publicKey),
      [GOOGLE]: new Response("busy", { status: 503 }),
      [CLOUDFLARE]: cloudflare(records(publicKey)),
    });
    expect(await checkKeyConsistency(kid, { fetch })).toEqual({
      status: "pass",
      matches: 3,
      of: 3,
    });
  });

  test("a resolver answering SERVFAIL or garbage is down, not a disagreement", async () => {
    const fetch = fakeFetch({
      [JWKS]: jwks(publicKey),
      [GOOGLE]: Response.json({ Status: 2 }),
      [CLOUDFLARE]: new Response("<html>", { status: 200 }),
    });
    expect(await checkKeyConsistency(kid, { fetch })).toEqual({
      status: "unavailable",
      matches: 2,
      of: 3,
    });
  });

  test("both DoH resolvers down → unavailable with matches 2 (pinned + JWKS)", async () => {
    const fetch = fakeFetch({ [JWKS]: jwks(publicKey), [GOOGLE]: "hang", [CLOUDFLARE]: "error" });
    const started = performance.now();
    expect(await checkKeyConsistency(kid, { fetch })).toEqual({
      status: "unavailable",
      matches: 2,
      of: 3,
    });
    const elapsed = performance.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(1_900);
    expect(elapsed).toBeLessThan(2_500);
  });

  test("JWKS down → unavailable with matches 2 (pinned + TXT)", async () => {
    const fetch = fakeFetch({
      [JWKS]: new Response("oops", { status: 500 }),
      [GOOGLE]: google(records(publicKey)),
      [CLOUDFLARE]: cloudflare(records(publicKey)),
    });
    expect(await checkKeyConsistency(kid, { fetch })).toEqual({
      status: "unavailable",
      matches: 2,
      of: 3,
    });
  });

  test("a disagreement wins over an outage", async () => {
    const fetch = fakeFetch({ [JWKS]: jwks(otherKey), [GOOGLE]: "error", [CLOUDFLARE]: "error" });
    expect(await checkKeyConsistency(kid, { fetch })).toEqual({
      status: "fail",
      detail: "doh_mismatch",
      matches: 1,
      of: 3,
    });
  });

  test("the caller's signal aborts every lookup", async () => {
    const fetch = fakeFetch({ [JWKS]: "hang", [GOOGLE]: "hang", [CLOUDFLARE]: "hang" });
    const controller = new AbortController();
    const result = checkKeyConsistency(kid, { fetch, signal: controller.signal });
    controller.abort();
    expect(await result).toEqual({ status: "unavailable", matches: 1, of: 3 });
  });

  test("a keyid that is not pinned fails without touching the network", async () => {
    const fetch = agreeing();
    expect(await checkKeyConsistency("rr-capture-unknown", { fetch })).toEqual({
      status: "fail",
      detail: "unknown_key",
      matches: 0,
      of: 3,
    });
    expect(fetch.calls).toEqual([]);
  });

  test("TXT parsing tolerates split strings and ignores other records", async () => {
    // A key record split into 255-byte character-strings, as DNS stores long TXT values.
    const value = `${kid}=${b64(publicKey)}`;
    const split = `"${value.slice(0, 20)}" "${value.slice(20)}"`;
    const fetch = fakeFetch({
      [JWKS]: jwks(publicKey),
      [GOOGLE]: Response.json({
        Status: 0,
        Answer: [
          { name: "_rr-keys.reranker.co.", type: 5, data: "elsewhere.example." },
          { name: "_rr-keys.reranker.co.", type: 16, data: "v=spf1 -all" },
          { name: "_rr-keys.reranker.co.", type: 16, data: value },
        ],
      }),
      [CLOUDFLARE]: Response.json({
        Status: 0,
        Answer: [
          { name: "_rr-keys.reranker.co", type: 16, data: '"google-site-verification=abc"' },
          { name: "_rr-keys.reranker.co", type: 16, data: '"with \\"quotes\\" and \\059"' },
          { name: "_rr-keys.reranker.co", type: 16, data: split },
        ],
      }),
    });
    expect(await checkKeyConsistency(kid, { fetch })).toEqual({
      status: "pass",
      matches: 3,
      of: 3,
    });
  });

  test("RFC 1035 escapes inside quoted strings are decoded before comparing", async () => {
    const value = `${kid}=${b64(publicKey)}`;
    const escaped = `"${value.replace("=", "\\061")}"`;
    const fetch = fakeFetch({
      [JWKS]: jwks(publicKey),
      [GOOGLE]: "error",
      [CLOUDFLARE]: Response.json({ Status: 0, Answer: [{ type: 16, data: escaped }] }),
    });
    expect(await checkKeyConsistency(kid, { fetch })).toMatchObject({ status: "pass", matches: 3 });
  });
});

describe("acceptsKeyAt", () => {
  test.each([
    ["anchored before compromise", "2026-12-01T00:00:00Z", "2026-11-20T00:00:00Z", true],
    ["anchored at the compromise instant", "2026-12-01T00:00:00Z", "2026-12-01T00:00:00Z", true],
    ["anchored after compromise", "2026-12-01T00:00:00Z", "2026-12-02T00:00:00Z", false],
    ["not anchored yet", "2026-12-01T00:00:00Z", null, false],
    ["anchored at an unreadable time", "2026-12-01T00:00:00Z", "yesterday", false],
    ["never compromised", null, null, true],
    ["never compromised, anchored", null, "2026-11-20T00:00:00Z", true],
  ] as const)("%s", (_, compromisedAfter, anchoredAt, ok) =>
    expect(acceptsKeyAt({ ...key, compromisedAfter }, anchoredAt)).toBe(ok),
  );

  test.each([
    ["anchored before retirement", "2026-12-01T00:00:00Z", "2026-11-20T00:00:00Z", true],
    ["anchored after retirement", "2026-12-01T00:00:00Z", "2026-12-02T00:00:00Z", false],
    // A retired key is disabled, not leaked: nobody else can have signed with it.
    ["retired, not anchored yet", "2026-12-01T00:00:00Z", null, true],
  ] as const)("%s", (_, validTo, anchoredAt, ok) =>
    expect(acceptsKeyAt({ ...key, validTo }, anchoredAt)).toBe(ok),
  );

  test("a signature anchored before the key existed is rejected", () => {
    expect(acceptsKeyAt(key, "2026-10-01T00:00:00Z")).toBe(false);
  });

  test("an unreadable date in the registry fails closed", () => {
    expect(acceptsKeyAt({ ...key, compromisedAfter: "soon" }, "2026-11-20T00:00:00Z")).toBe(false);
    expect(acceptsKeyAt({ ...key, validFrom: "" }, "2026-11-20T00:00:00Z")).toBe(false);
  });
});
