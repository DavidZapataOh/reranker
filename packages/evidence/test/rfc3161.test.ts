import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  buildTimeStampReq,
  derInteger,
  parseTimeStampResp,
  requestTimestamp,
  TSAS,
} from "../src/anchors/rfc3161";
import { resetEvidenceEnv } from "../src/env";
import { previewEnv, productionEnv } from "./support/evidence-env";

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const fixture = (name: string) =>
  new Uint8Array(readFileSync(new URL(`./fixtures/tsa/${name}`, import.meta.url)));

// A real DigiCert reply, recorded with `openssl ts -query -sha256 -cert` and verified with
// `openssl ts -verify -CAfile digicert-chain.pem`.
const granted = {
  bytes: fixture("digicert-granted.tsr"),
  digest: new Uint8Array(
    Buffer.from("e70959011cb438c00445d07342994729cc4a5df785f0c9e626a85e9b58a32f5e", "hex"),
  ),
  nonce: 0xf04ed33aa4ef5b33n,
};
// TimeStampResp { PKIStatusInfo { status } } with no token.
const refusal = (status: number) => new Uint8Array([0x30, 0x05, 0x30, 0x03, 0x02, 0x01, status]);

afterEach(() => {
  vi.unstubAllEnvs();
  resetEvidenceEnv();
});

describe("buildTimeStampReq", () => {
  test("without a nonce it is byte-identical to openssl ts -query -sha256 -cert -no_nonce", () => {
    const digest = new Uint8Array(randomBytes(32));
    const theirs = execFileSync(
      "openssl",
      ["ts", "-query", "-digest", hex(digest), "-sha256", "-cert", "-no_nonce"],
      { stdio: "pipe" },
    );
    expect(Buffer.from(buildTimeStampReq(digest))).toEqual(theirs);
  });

  test("openssl reads the nonce it carries", () => {
    const query = buildTimeStampReq(new Uint8Array(32), { nonce: 0xf04ed33aa4ef5b33n });
    const file = join(mkdtempSync(join(tmpdir(), "tsq-")), "query.tsq");
    writeFileSync(file, query);
    const text = execFileSync("openssl", ["ts", "-query", "-in", file, "-text"], {
      encoding: "utf8",
      stdio: "pipe",
    });
    rmSync(dirname(file), { recursive: true });
    expect(text).toContain("Nonce: 0xF04ED33AA4EF5B33");
    expect(text).toContain("Certificate required: yes");
  });

  test("only takes a SHA-256 digest and a positive nonce", () => {
    expect(() => buildTimeStampReq(new Uint8Array(20))).toThrow(RangeError);
    expect(() => derInteger(0n)).toThrow(RangeError);
  });

  test("encodes nonces as minimal positive DER integers", () => {
    expect(hex(derInteger(1n))).toBe("020101");
    expect(hex(derInteger(0x80n))).toBe("02020080");
    expect(hex(derInteger(0x1234n))).toBe("02021234");
  });
});

describe("parseTimeStampResp", () => {
  test("a granted reply carries a token", () => {
    expect(parseTimeStampResp(granted.bytes)).toEqual({ status: 0, granted: true });
  });

  test("a rejection status is not granted", () => {
    expect(parseTimeStampResp(refusal(2))).toEqual({ status: 2, granted: false });
  });

  test("a granted status without a token is not granted", () => {
    expect(parseTimeStampResp(refusal(0))).toEqual({ status: 0, granted: false });
  });

  test.each([
    ["empty", []],
    ["not a sequence", [0x04, 0x00]],
    ["trailing bytes", [0x30, 0x05, 0x30, 0x03, 0x02, 0x01, 0x00, 0x00]],
    ["truncated", [0x30, 0x05, 0x30, 0x03, 0x02, 0x01]],
    ["status not an integer", [0x30, 0x05, 0x30, 0x03, 0x04, 0x01, 0x00]],
    ["unknown status", [0x30, 0x05, 0x30, 0x03, 0x02, 0x01, 0x06]],
    ["indefinite length", [0x30, 0x80, 0x00, 0x00]],
  ])("rejects %s", (_, bytes) => {
    expect(() => parseTimeStampResp(new Uint8Array(bytes))).toThrow(TypeError);
  });
});

describe("requestTimestamp", () => {
  function tsa(reply: () => Response) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const f = (async (input: string | URL | Request, init: RequestInit = {}) => {
      calls.push({ url: String(input), init });
      return reply();
    }) as typeof fetch;
    return Object.assign(f, { calls });
  }

  test("posts the query as the provider guides show and returns the whole reply", async () => {
    const f = tsa(() => new Response(granted.bytes.slice()));
    const reply = await requestTimestamp("http://timestamp.digicert.com", granted.digest, {
      fetch: f,
      nonce: granted.nonce,
    });
    expect(reply).toEqual(granted.bytes);
    const [call] = f.calls;
    expect(call?.url).toBe("http://timestamp.digicert.com/");
    expect(call?.init).toMatchObject({
      method: "POST",
      headers: { "Content-Type": "application/timestamp-query" },
      redirect: "error",
    });
    expect(call?.init.body).toEqual(buildTimeStampReq(granted.digest, { nonce: granted.nonce }));
  });

  test("sends URL credentials as Basic auth, never in the URL", async () => {
    const f = tsa(() => new Response(granted.bytes.slice()));
    await requestTimestamp("https://us%40r:p%3Ass@tsa.example/stamp", granted.digest, {
      fetch: f,
      nonce: granted.nonce,
    });
    expect(f.calls[0]?.url).toBe("https://tsa.example/stamp");
    expect(f.calls[0]?.init.headers).toMatchObject({
      Authorization: `Basic ${Buffer.from("us@r:p:ss").toString("base64")}`,
    });
  });

  test("a refusal is an error, not a proof", async () => {
    const f = tsa(() => new Response(refusal(2)));
    await expect(
      requestTimestamp("https://tsa.example", granted.digest, { fetch: f }),
    ).rejects.toThrow("PKIStatus 2");
  });

  test("a reply for another digest or nonce is refused", async () => {
    const f = tsa(() => new Response(granted.bytes.slice()));
    await expect(
      requestTimestamp("https://tsa.example", new Uint8Array(32), {
        fetch: f,
        nonce: granted.nonce,
      }),
    ).rejects.toThrow("requested digest and nonce");
    await expect(
      requestTimestamp("https://tsa.example", granted.digest, { fetch: f, nonce: 7n }),
    ).rejects.toThrow("requested digest and nonce");
  });

  test("an HTTP error or an oversized reply is an error", async () => {
    await expect(
      requestTimestamp("https://tsa.example", granted.digest, {
        fetch: tsa(() => new Response("busy", { status: 503 })),
      }),
    ).rejects.toThrow("TSA answered 503");
    await expect(
      requestTimestamp("https://tsa.example", granted.digest, {
        fetch: tsa(() => new Response(new Uint8Array(10_241))),
      }),
    ).rejects.toThrow("over 10240 bytes");
  });

  test("a random nonce is sent when none is given", async () => {
    const f = tsa(() => new Response(granted.bytes.slice()));
    await expect(
      requestTimestamp("https://tsa.example", granted.digest, { fetch: f }),
    ).rejects.toThrow("nonce");
    expect(f.calls[0]?.init.body).not.toEqual(buildTimeStampReq(granted.digest));
  });
});

describe("TSAS", () => {
  test("qtsa.eu exists only where its endpoint is configured; DigiCert always", () => {
    for (const [name, value] of Object.entries(previewEnv)) vi.stubEnv(name, value);
    resetEvidenceEnv();
    expect(TSAS.qtsa.url()).toBeNull();
    expect(TSAS.digicert.url()).toBe("http://timestamp.digicert.com");

    for (const [name, value] of Object.entries(productionEnv)) vi.stubEnv(name, value);
    resetEvidenceEnv();
    expect(TSAS.qtsa.url()).toBe(productionEnv.QTSA_TSA_URL);
  });
});
