import {
  GetPublicKeyCommand,
  KMSClient,
  KMSServiceException,
  NotFoundException,
  SignCommand,
} from "@aws-sdk/client-kms";
import { resetAppEnv } from "@reranker/env";
import type { TrustedKey } from "@reranker/verify/trust";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { SigningKeyMismatchError, SigningUnavailableError } from "../src/errors";
import {
  connectKmsSigner,
  kmsSigner,
  loadSigner,
  resetSigners,
  signingProvisioned,
} from "../src/signer";
import { productionEnv } from "./support/evidence-env";

const registry = vi.hoisted(() => ({
  production: [] as TrustedKey[],
  preview: [] as TrustedKey[],
}));
vi.mock("@reranker/verify/trust", () => ({ KEYS_BY_ENV: registry }));

const asKms = (send: (...args: unknown[]) => Promise<unknown>) =>
  ({ send }) as unknown as Pick<KMSClient, "send">;
const replying = (value: unknown) => asKms(vi.fn(async () => value));
const failing = (error: unknown) => asKms(vi.fn(async () => Promise.reject(error)));
const serviceError = (name: string, $fault: "client" | "server" = "client") =>
  new KMSServiceException({ name, $fault, $metadata: {} });

const utf8 = (s: string) => new TextEncoder().encode(s);
const arn = "arn:aws:kms:us-east-1:111122223333:key/1234abcd-12ab-34cd-56ef-1234567890ab";
const spki = (pub: Uint8Array) =>
  Uint8Array.from([...Buffer.from("302a300506032b6570032100", "hex"), ...pub]);
const pubA = new Uint8Array(32).fill(7);
const pubB = new Uint8Array(32).fill(9);
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

const trusted = (overrides: Partial<TrustedKey> = {}): TrustedKey => ({
  keyid: "rr-capture-test-1-ed25519",
  purpose: "capture",
  env: "preview",
  alg: "Ed25519",
  publicKey: b64(pubA),
  custody: "aws-kms-hsm",
  validFrom: "2026-01-01T00:00:00Z",
  validTo: null,
  compromisedAfter: null,
  ...overrides,
});

const signWith = (client: Pick<KMSClient, "send">) =>
  kmsSigner({ client, keyArn: arn, keyid: "k", publicKey: pubA }).sign(utf8("m"));

describe("kmsSigner", () => {
  test("sends ED25519_SHA_512 with RAW messages and a timeout", async () => {
    const send = vi.fn(async () => ({ Signature: new Uint8Array(64).fill(1) }));
    expect(await signWith(asKms(send))).toEqual(new Uint8Array(64).fill(1));
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        constructor: SignCommand,
        input: {
          KeyId: arn,
          Message: utf8("m"),
          MessageType: "RAW",
          SigningAlgorithm: "ED25519_SHA_512",
        },
      }),
      { abortSignal: expect.any(AbortSignal) },
    );
  });

  test.each([
    ["ThrottlingException", SigningUnavailableError],
    ["KMSInternalException", SigningUnavailableError],
    ["DependencyTimeoutException", SigningUnavailableError],
    ["KeyUnavailableException", SigningUnavailableError],
    ["AccessDeniedException", SigningKeyMismatchError],
    ["DisabledException", SigningKeyMismatchError],
    ["KMSInvalidStateException", SigningKeyMismatchError],
    ["InvalidKeyUsageException", SigningKeyMismatchError],
  ])("%s maps to %O", async (name, type) => {
    const error = await signWith(failing(serviceError(name))).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(type);
    expect((error as Error).cause).toBeInstanceOf(KMSServiceException);
  });

  test("a modeled NotFoundException is a key mismatch that names the key", async () => {
    await expect(
      signWith(failing(new NotFoundException({ message: "no key", $metadata: {} }))),
    ).rejects.toMatchObject({ name: "SigningKeyMismatch", keyid: "k" });
  });

  test("a server fault, a network error, a timeout or an empty response are unavailable", async () => {
    for (const client of [
      failing(serviceError("ServiceUnavailableException", "server")),
      failing(Object.assign(new Error("socket hang up"), { code: "ECONNRESET" })),
      failing(new DOMException("The operation timed out.", "TimeoutError")),
      replying({}),
    ]) {
      await expect(signWith(client)).rejects.toBeInstanceOf(SigningUnavailableError);
    }
  });

  test("any other KMS client error is rethrown unchanged", async () => {
    const thrown = serviceError("ValidationException");
    await expect(signWith(failing(thrown))).rejects.toBe(thrown);
  });
});

describe("connectKmsSigner", () => {
  test("returns a signer for the registered key when KMS holds the same public key", async () => {
    const send = vi.fn(async () => ({ PublicKey: spki(pubA) }));
    const signer = await connectKmsSigner({ client: asKms(send), keyArn: arn, key: trusted() });
    expect(signer).toMatchObject({ keyid: "rr-capture-test-1-ed25519", publicKey: pubA });
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ constructor: GetPublicKeyCommand, input: { KeyId: arn } }),
      { abortSignal: expect.any(AbortSignal) },
    );
  });

  test("refuses a KMS public key that is not in the registry or not an Ed25519 SPKI", async () => {
    for (const PublicKey of [spki(pubB), pubA, Uint8Array.from([...spki(pubA), 0]), undefined]) {
      await expect(
        connectKmsSigner({ client: replying({ PublicKey }), keyArn: arn, key: trusted() }),
      ).rejects.toBeInstanceOf(SigningKeyMismatchError);
    }
  });

  test("fails closed without a registered key and never calls KMS", async () => {
    const send = vi.fn();
    await expect(
      connectKmsSigner({ client: asKms(send), keyArn: arn, key: undefined }),
    ).rejects.toBeInstanceOf(SigningKeyMismatchError);
    expect(send).not.toHaveBeenCalled();
  });

  test("maps GetPublicKey failures like Sign failures", async () => {
    await expect(
      connectKmsSigner({
        client: failing(serviceError("ThrottlingException")),
        keyArn: arn,
        key: trusted(),
      }),
    ).rejects.toBeInstanceOf(SigningUnavailableError);
  });
});

describe("loadSigner", () => {
  const send = vi.spyOn(KMSClient.prototype, "send");
  const getPublicKey = (KeyId: string) =>
    expect.objectContaining({ constructor: GetPublicKeyCommand, input: { KeyId } });

  beforeEach(() => {
    resetAppEnv();
    resetSigners();
    send.mockReset();
    vi.stubEnv("APP_ENV", "preview");
    vi.stubEnv("AWS_REGION", "us-east-1");
    vi.stubEnv("AWS_ROLE_ARN", "arn:aws:iam::111122223333:role/reranker-evidence-preview");
    vi.stubEnv("EVIDENCE_CAPTURE_KMS_KEY_ARN", arn);
    vi.stubEnv("EVIDENCE_LOG_KMS_KEY_ARN", `${arn}-log`);
    registry.production = [
      trusted({ env: "production", keyid: "rr-capture-prod", publicKey: b64(pubB) }),
    ];
    registry.preview = [
      trusted({ keyid: "rr-capture-old", validTo: "2026-06-01T00:00:00Z" }),
      trusted({ keyid: "rr-capture-leaked", compromisedAfter: "2026-07-01T00:00:00Z" }),
      trusted(),
      trusted({ keyid: "rr-log-test-1", purpose: "log" }),
    ];
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    resetAppEnv();
  });

  test("uses the current key of this environment and purpose, and memoizes the signer", async () => {
    send.mockImplementation(async () => ({ PublicKey: spki(pubA) }));
    const first = await loadSigner("capture");
    expect(await loadSigner("capture")).toBe(first);
    expect(first.keyid).toBe("rr-capture-test-1-ed25519");
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenNthCalledWith(1, getPublicKey(arn), expect.anything());

    expect((await loadSigner("log")).keyid).toBe("rr-log-test-1");
    expect(send).toHaveBeenNthCalledWith(2, getPublicKey(`${arn}-log`), expect.anything());
  });

  test("production uses the production registry, and a failure is not memoized", async () => {
    for (const [name, value] of Object.entries(productionEnv)) vi.stubEnv(name, value);
    vi.stubEnv("EVIDENCE_CAPTURE_KMS_KEY_ARN", arn);
    resetAppEnv();
    send.mockImplementationOnce(async () => ({ PublicKey: spki(pubA) }));
    await expect(loadSigner("capture")).rejects.toBeInstanceOf(SigningKeyMismatchError);
    send.mockImplementationOnce(async () => ({ PublicKey: spki(pubB) }));
    expect((await loadSigner("capture")).keyid).toBe("rr-capture-prod");
  });

  test("names the missing variables without calling KMS", async () => {
    vi.stubEnv("EVIDENCE_LOG_KMS_KEY_ARN", "");
    vi.stubEnv("AWS_ROLE_ARN", undefined);
    await expect(loadSigner("log")).rejects.toThrow(
      /AWS_ROLE_ARN \(missing\), EVIDENCE_LOG_KMS_KEY_ARN \(missing\)/,
    );
    expect(send).not.toHaveBeenCalled();
  });
});

describe("signingProvisioned", () => {
  beforeEach(() => {
    resetAppEnv();
    resetSigners();
    vi.stubEnv("APP_ENV", "preview");
    vi.stubEnv("AWS_REGION", "us-east-1");
    vi.stubEnv("AWS_ROLE_ARN", "arn:aws:iam::111122223333:role/reranker-evidence-preview");
    vi.stubEnv("EVIDENCE_CAPTURE_KMS_KEY_ARN", arn);
    registry.preview = [trusted()];
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    resetAppEnv();
    resetSigners();
  });

  test("needs a current key in this environment's registry and the variables that reach KMS", () => {
    expect(signingProvisioned("capture")).toBe(true);
    expect(signingProvisioned("log")).toBe(false);
  });

  test("is false without a current key, as a registry without preview keys leaves previews", () => {
    registry.preview = [trusted({ validTo: "2026-06-01T00:00:00Z" })];
    expect(signingProvisioned("capture")).toBe(false);
  });

  test.each(["AWS_REGION", "AWS_ROLE_ARN", "EVIDENCE_CAPTURE_KMS_KEY_ARN"])(
    "is false without %s",
    (name) => {
      vi.stubEnv(name, undefined);
      resetSigners();
      expect(signingProvisioned("capture")).toBe(false);
    },
  );
});
