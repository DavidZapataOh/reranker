import { createHash } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519.js";
import { noteKeyId } from "@reranker/verify/trust";
import { describe, expect, test } from "vitest";
import { SigningKeyMismatchError } from "../src/errors";
import {
  checkpointDigest,
  formatCheckpoint,
  parseCheckpoint,
  signCheckpoint,
} from "../src/log/checkpoint";
import type { Signer } from "../src/signer";
import { localSigner } from "./support/local-signer";

const ORIGIN = "log.reranker.co/captures/2026";
const root = createHash("sha256").update("root").digest();
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
const b64decode = (s: string) => new Uint8Array(Buffer.from(s, "base64"));
const utf8 = (s: string) => new TextEncoder().encode(s);
const sha256Of = (bytes: Uint8Array) => new Uint8Array(createHash("sha256").update(bytes).digest());

const signer = localSigner("rr-log-test-1");
const body = formatCheckpoint({ origin: ORIGIN, size: 1240, root });

describe("formatCheckpoint", () => {
  test("checkpoint body has exactly three lines and a trailing newline", () =>
    expect(formatCheckpoint({ origin: ORIGIN, size: 1240, root })).toBe(
      `log.reranker.co/captures/2026\n1240\n${b64(root)}\n`,
    ));

  test("the empty tree is size 0", () =>
    expect(formatCheckpoint({ origin: ORIGIN, size: 0, root }).split("\n")[1]).toBe("0"));

  test.each([
    ["an empty origin", { origin: "", size: 1, root }],
    ["an origin with a newline", { origin: "a\nb", size: 1, root }],
    ["an origin with a control character", { origin: "a\tb", size: 1, root }],
    ["a negative size", { origin: ORIGIN, size: -1, root }],
    ["a fractional size", { origin: ORIGIN, size: 1.5, root }],
    ["an unsafe size", { origin: ORIGIN, size: 2 ** 53, root }],
    ["a short root", { origin: ORIGIN, size: 1, root: root.subarray(0, 31) }],
  ])("rejects %s", (_, checkpoint) => expect(() => formatCheckpoint(checkpoint)).toThrow());
});

describe("signCheckpoint", () => {
  test("signature line uses the em dash, the key name and keyID ‖ sig", async () => {
    const note = await signCheckpoint(body, signer, ORIGIN);
    const [text, line = ""] = note.split("\n\n");
    expect(`${text}\n`).toBe(body);
    expect(line).toMatch(/^— log\.reranker\.co\/captures\/2026 [A-Za-z0-9+/]{91}=\n$/);
    expect(b64decode(line.split(" ")[2] ?? "").subarray(0, 4)).toEqual(
      noteKeyId(ORIGIN, signer.publicKey),
    );
  });

  test("signs the note text, final newline included, with Ed25519", async () => {
    const note = await signCheckpoint(body, signer, ORIGIN);
    const sig = b64decode(note.trimEnd().split(" ").at(-1) ?? "").subarray(4);
    expect(ed25519.verify(sig, utf8(body), signer.publicKey, { zip215: false })).toBe(true);
    expect(ed25519.verify(sig, utf8(body.trimEnd()), signer.publicKey, { zip215: false })).toBe(
      false,
    );
  });

  test("refuses to sign a body that is not a checkpoint", async () => {
    await expect(signCheckpoint(body.trimEnd(), signer, ORIGIN)).rejects.toThrow(TypeError);
    await expect(signCheckpoint(`${body}\n`, signer, ORIGIN)).rejects.toThrow(TypeError);
    await expect(signCheckpoint(`${ORIGIN}\n01\n${b64(root)}\n`, signer, ORIGIN)).rejects.toThrow(
      TypeError,
    );
  });

  test("refuses a key name the note format cannot carry", async () =>
    expect(signCheckpoint(body, signer, "log reranker")).rejects.toThrow(TypeError));

  test("a signature that is not Ed25519 never reaches the note", async () => {
    const short: Signer = { ...signer, sign: async () => new Uint8Array(63) };
    await expect(signCheckpoint(body, short, ORIGIN)).rejects.toThrow(SigningKeyMismatchError);
  });
});

describe("parseCheckpoint", () => {
  test("round-trips a signed checkpoint", async () => {
    const note = await signCheckpoint(body, signer, ORIGIN);
    const parsed = parseCheckpoint(note);
    expect(parsed).toEqual({ origin: ORIGIN, size: 1240, root: new Uint8Array(root), body });
  });

  test("keeps extension lines in the body", () => {
    const text = `${body}ext-line\n`;
    const parsed = parseCheckpoint(`${text}\n— ${ORIGIN} ${b64(new Uint8Array(68))}\n`);
    expect(parsed.body).toBe(text);
    expect(parsed.size).toBe(1240);
  });

  test("accepts several signature lines", () => {
    const sig = `— ${ORIGIN} ${b64(new Uint8Array(68))}\n`;
    expect(parseCheckpoint(`${body}\n${sig}${sig.replace(ORIGIN, "witness.example")}`).body).toBe(
      body,
    );
  });

  const sig = `— ${ORIGIN} ${b64(new Uint8Array(68))}\n`;
  test.each([
    ["no signature", `${body}\n`],
    ["no blank line", `${body}${sig}`],
    ["a signature line without the em dash", `${body}\n- ${ORIGIN} ${b64(new Uint8Array(68))}\n`],
    ["a signature without a key ID", `${body}\n— ${ORIGIN} ${b64(new Uint8Array(3))}\n`],
    ["non-canonical signature base64", `${body}\n— ${ORIGIN} AAAAAB==\n`],
    ["no final newline", `${body}\n${sig.trimEnd()}`],
    ["two lines of text", `${ORIGIN}\n1240\n\n${sig}`],
    ["an empty extension line", `${ORIGIN}\n1240\n${b64(root)}\n\next\n\n${sig}`],
    ["a size with a leading zero", `${ORIGIN}\n01240\n${b64(root)}\n\n${sig}`],
    ["a size with a sign", `${ORIGIN}\n+1240\n${b64(root)}\n\n${sig}`],
    ["an unsafe size", `${ORIGIN}\n9007199254740992\n${b64(root)}\n\n${sig}`],
    ["a 31-byte root", `${ORIGIN}\n1240\n${b64(root.subarray(1))}\n\n${sig}`],
    ["a non-canonical root", `${ORIGIN}\n1240\n${b64(root).replace("=", "")}\n\n${sig}`],
    ["a control character", `${ORIGIN}\r\n1240\n${b64(root)}\n\n${sig}`],
  ])("rejects %s", (_, note) => expect(() => parseCheckpoint(note)).toThrow(TypeError));
});

describe("checkpointDigest", () => {
  test("checkpointDigest ignores the signature", async () => {
    const note = await signCheckpoint(body, signer, ORIGIN);
    const other = await signCheckpoint(body, localSigner("rr-log-test-2"), ORIGIN);
    expect(checkpointDigest(note)).toEqual(sha256Of(utf8(body)));
    expect(checkpointDigest(other)).toEqual(checkpointDigest(note));
  });
});
