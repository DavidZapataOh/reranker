import { readFileSync } from "node:fs";
import { ed25519 } from "@noble/curves/ed25519.js";
import { describe, expect, test } from "vitest";
import type { Check } from "../src/dsse";
import { parseSignedNote, verifyCheckpoint } from "../src/note";
import { noteKeyId, noteVerifierKey, type TrustedKey } from "../src/trust/keys";

type GoNote = {
  name: string;
  origin: string;
  vkey: string;
  publicKey: string;
  note: string;
  go: "ok" | "unverified" | "invalid_signature" | "malformed";
};

// Signed by golang.org/x/mod/sumdb/note; `go run . --check` in test/go/note keeps it current.
const notes: GoNote[] = JSON.parse(
  readFileSync(new URL("./fixtures/notes.json", import.meta.url), "utf8"),
);
const goNote = (name: string) => {
  const found = notes.find((n) => n.name === name);
  if (!found) throw new Error(`no fixture named ${name}`);
  return found;
};

const PRODUCTION = "log.reranker.co/captures/2026";

const logKey = (publicKey: string, purpose: TrustedKey["purpose"] = "log"): TrustedKey => ({
  keyid: "rr-log-test-1",
  purpose,
  env: "preview",
  alg: "Ed25519",
  publicKey,
  custody: "aws-kms-hsm",
  validFrom: "2026-01-01T00:00:00Z",
  validTo: null,
  compromisedAfter: null,
});

const verify = (n: GoNote, note = n.note) =>
  verifyCheckpoint(note, [logKey(n.publicKey)], n.origin);

const base64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const fromBase64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

const pass: Check = { status: "pass" };
const fail = (detail: string): Check => ({ status: "fail", detail });

// The verdict for every Go fixture. Go's note.Open checks the signed note only; the checkpoint
// body and its origin are this verifier's job, so those notes open in Go but fail here.
const expected: Record<string, Check> = {
  "production checkpoint": pass,
  "preview checkpoint": pass,
  "empty tree": pass,
  "extension line": pass,
  "cosigned by an unknown witness": pass,
  "same name, unknown key id": pass,
  "only an unknown key": fail("untrusted_log_key"),
  "only an unknown witness": fail("untrusted_log_key"),
  "text changed after signing": fail("bad_signature"),
  "signature from another note": fail("bad_signature"),
  "no signature block": fail("malformed"),
  "control character": fail("malformed"),
  "leading zero in size": fail("malformed"),
  "non-decimal size": fail("malformed"),
  "root is not 32 bytes": fail("malformed"),
  "empty extension line": fail("malformed"),
  "two lines": fail("malformed"),
  "another origin": fail("origin_mismatch"),
};

const goDetail = {
  unverified: "untrusted_log_key",
  invalid_signature: "bad_signature",
  malformed: "malformed",
} as const;

describe("verifyCheckpoint against golang.org/x/mod/sumdb/note", () => {
  test("every fixture has an expected verdict", () =>
    expect(notes.map((n) => n.name).sort()).toEqual(Object.keys(expected).sort()));

  test.each(notes)("$name", (n) => expect(verify(n).check).toEqual(expected[n.name]));

  test.each(notes.filter((n) => n.go !== "ok"))("rejects what Go rejects: $name", (n) =>
    expect(verify(n).check).toEqual(fail(goDetail[n.go as keyof typeof goDetail])),
  );

  test.each(notes.filter((n) => expected[n.name]?.status === "pass"))(
    "accepts only what Go accepts: $name",
    (n) => expect(n.go).toBe("ok"),
  );

  test("the verifier key Go uses is the one derived from the pinned key", () => {
    for (const n of notes) expect(noteVerifierKey(n.origin, fromBase64(n.publicKey))).toBe(n.vkey);
  });
});

describe("verifyCheckpoint", () => {
  const valid = goNote("production checkpoint");

  test("a Go-signed checkpoint verifies with the log key", () => {
    const result = verify(valid);
    expect(result.check.status).toBe("pass");
    if (!("size" in result)) throw new Error("no tree head");
    expect(result.size).toBe(1240);
    expect(base64(result.root)).toBe(valid.note.split("\n")[2]);
  });

  test("a preview log verifies under its own origin", () =>
    expect(verify(goNote("preview checkpoint")).check).toEqual(pass));

  test("signatures from unknown keys are ignored, as signed-note requires", () =>
    expect(verify(goNote("cosigned by an unknown witness")).check).toEqual(pass));

  test("only an unknown key signed it → fail untrusted", () =>
    expect(verify(goNote("only an unknown key")).check).toEqual(fail("untrusted_log_key")));

  test("another origin, a non-decimal size or a body without trailing newline fails", () => {
    expect(
      verifyCheckpoint(valid.note, [logKey(valid.publicKey)], "log.example.org/x").check,
    ).toEqual(fail("origin_mismatch"));
    expect(verify(goNote("non-decimal size")).check).toEqual(fail("malformed"));
    expect(verify(valid, valid.note.replace("\n\n", "\n")).check).toEqual(fail("malformed"));
    expect(verify(valid, valid.note.slice(0, -1)).check).toEqual(fail("malformed"));
  });

  test("failures carry no tree head", () =>
    expect(verify(goNote("only an unknown key"))).not.toHaveProperty("size"));

  test("a capture key with the log's public key is not a log key", () =>
    expect(
      verifyCheckpoint(valid.note, [logKey(valid.publicKey, "capture")], PRODUCTION).check,
    ).toEqual(fail("untrusted_log_key")));

  test("a known key's signature of the wrong length fails instead of being ignored", () => {
    const keyId = noteKeyId(PRODUCTION, fromBase64(valid.publicKey));
    const short = `${valid.note.slice(0, valid.note.lastIndexOf("\n\n"))}\n\n— ${PRODUCTION} ${base64(new Uint8Array([...keyId, 1, 2, 3]))}\n`;
    expect(verify(valid, short).check).toEqual(fail("bad_signature"));
  });

  test("one bad signature from the log key rejects the whole note", () => {
    const good = valid.note.slice(valid.note.lastIndexOf("\n\n") + 2);
    const other = goNote("signature from another note").note;
    const bad = other.slice(other.lastIndexOf("\n\n") + 2);
    expect(verify(valid, `${valid.note}${bad}`).check).toEqual(fail("bad_signature"));
    expect(verify(valid, `${valid.note.slice(0, -good.length)}${bad}${good}`).check).toEqual(
      fail("bad_signature"),
    );
  });

  test("a key that is not 32 bytes never throws", () =>
    expect(
      verifyCheckpoint(valid.note, [logKey(base64(new Uint8Array(33)))], PRODUCTION).check,
    ).toEqual(fail("untrusted_log_key")));

  test("an Ed25519 signature made outside Go verifies too", () => {
    const secret = ed25519.utils.randomSecretKey();
    const publicKey = ed25519.getPublicKey(secret);
    const body = `${PRODUCTION}\n3\n${base64(new Uint8Array(32).fill(7))}\n`;
    const sig = ed25519.sign(new TextEncoder().encode(body), secret);
    const line = base64(new Uint8Array([...noteKeyId(PRODUCTION, publicKey), ...sig]));
    const note = `${body}\n— ${PRODUCTION} ${line}\n`;
    expect(verifyCheckpoint(note, [logKey(base64(publicKey))], PRODUCTION)).toMatchObject({
      check: pass,
      size: 3,
    });
  });
});

describe("parseSignedNote", () => {
  const cosigned = goNote("cosigned by an unknown witness").note;

  test("splits the text from every signature line", () => {
    const parsed = parseSignedNote(cosigned);
    expect(parsed?.body).toBe(cosigned.slice(0, cosigned.lastIndexOf("\n\n") + 1));
    expect(parsed?.signatures.map((s) => s.name)).toEqual(["witness.example/w1", PRODUCTION]);
    for (const s of parsed?.signatures ?? []) {
      expect(s.keyId).toHaveLength(4);
      expect(s.sig).toHaveLength(64);
    }
  });

  test("the text may contain empty lines: only the last one separates signatures", () => {
    const text = goNote("empty extension line").note;
    expect(parseSignedNote(text)?.body).toBe(`${text.split("\n").slice(0, 5).join("\n")}\n`);
  });

  const line = (name: string, b64: string) => `text\n\n— ${name} ${b64}\n`;
  const sig = base64(new Uint8Array(68).fill(1));

  test.each<[string, string]>([
    ["no newline at the end", `text\n\n— a ${sig}`],
    ["no blank line", `text\n— a ${sig}\n`],
    ["no signature", "text\n\n"],
    ["a hyphen instead of an em dash", `text\n\n- a ${sig}\n`],
    ["an empty key name", line("", sig)],
    ["a plus sign in the key name", line("a+b", sig)],
    ["a no-break space in the key name", line("a b", sig)],
    ["a next-line character in the key name", line("a\u0085b", sig)],
    ["no signature bytes after the key ID", line("a", base64(new Uint8Array(4)))],
    ["unpadded base64", line("a", sig.replace(/=+$/, ""))],
    ["non-canonical base64", line("a", `${sig.slice(0, -2)}F=`)],
    ["characters outside base64", line("a", `${sig.slice(0, -4)}AA*=`)],
    ["a tab", `te\txt\n\n— a ${sig}\n`],
    ["a carriage return", `text\r\n\n— a ${sig}\n`],
    ["a lone surrogate", `te\ud800xt\n\n— a ${sig}\n`],
    ["more than 100 signatures", `text\n\n${`— a ${sig}\n`.repeat(101)}`],
  ])("rejects %s", (_, text) => expect(parseSignedNote(text)).toBeNull());

  test("accepts 100 signatures and non-ASCII text", () => {
    const parsed = parseSignedNote(`año ✓\n\n${`— a ${sig}\n`.repeat(100)}`);
    expect(parsed?.signatures).toHaveLength(100);
    expect(parsed?.body).toBe("año ✓\n");
  });
});
