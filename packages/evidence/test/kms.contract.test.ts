import {
  GetPublicKeyCommand,
  KMSClient,
  KMSServiceException,
  SignCommand,
} from "@aws-sdk/client-kms";
import { requireEnv } from "@reranker/testing/env";
import { verifyEd25519 } from "@reranker/verify";
import { DSSE_PAYLOAD_TYPE, pae } from "@reranker/verify/format";
import { KEYS_BY_ENV } from "@reranker/verify/trust";
import { afterAll, expect, test } from "vitest";
import { KEYS, REGION } from "../scripts/aws-state";
import { connectKmsSigner } from "../src/signer";

// The real preview keys in AWS KMS, reached as the `reranker-ci-kms-preview` role that the
// nightly `evidence-kms` job assumes through GitHub OIDC. The credentials come from the
// environment that aws-actions/configure-aws-credentials exports.
const account = requireEnv("AWS_ACCOUNT_ID");
const client = new KMSClient({ region: REGION });
afterAll(() => client.destroy());

const aliasArn = (alias: string) => `arn:aws:kms:${REGION}:${account}:${alias}`;
const specOf = (keyid: string) => {
  const spec = KEYS.find((k) => k.keyid === keyid);
  if (!spec) throw new Error(`${keyid} is not declared in aws-state.ts`);
  return spec;
};

const capture = KEYS_BY_ENV.preview.find((k) => k.purpose === "capture");
const statement = new TextEncoder().encode(
  JSON.stringify({ _type: "https://in-toto.io/Statement/v1", probe: crypto.randomUUID() }),
);
const message = pae(DSSE_PAYLOAD_TYPE, statement);
const pinned = (base64: string) => Uint8Array.from(Buffer.from(base64, "base64"));

test("the preview capture key signs a PAE that verifies against its pinned public key", async () => {
  if (!capture) throw new Error("no preview capture key is pinned");
  const signer = await connectKmsSigner({
    client,
    keyArn: aliasArn(specOf(capture.keyid).alias),
    key: capture,
  });
  const signature = await signer.sign(message);
  expect(signature).toHaveLength(64);
  expect(verifyEd25519(pinned(capture.publicKey), message, signature)).toBe(true);
  expect(
    verifyEd25519(pinned(capture.publicKey), pae(DSSE_PAYLOAD_TYPE, new Uint8Array()), signature),
  ).toBe(false);

  // Production signs from iad1, in this same region; a GitHub runner adds its own distance, so
  // only a gross regression fails here.
  const durations: number[] = [];
  for (let i = 0; i < 50; i++) {
    const started = performance.now();
    await signer.sign(message);
    durations.push(performance.now() - started);
  }
  durations.sort((a, b) => a - b);
  const p95 = durations[Math.ceil(durations.length * 0.95) - 1] ?? Number.POSITIVE_INFINITY;
  console.info(
    `KMS Sign from the runner: p50 ${durations[24]?.toFixed(1)} ms, p95 ${p95.toFixed(1)} ms`,
  );
  expect(p95).toBeLessThan(400);
});

test.for(KEYS_BY_ENV.preview.filter((k) => k.purpose === "log"))(
  "KMS holds the pinned public key of $keyid",
  async (key) => {
    const signer = await connectKmsSigner({
      client,
      keyArn: aliasArn(specOf(key.keyid).alias),
      key,
    });
    expect(Buffer.from(signer.publicKey).toString("base64")).toBe(key.publicKey);
  },
);

const refusal = (call: Promise<unknown>) =>
  call.then(
    () => "allowed",
    (error: unknown) => (error instanceof KMSServiceException ? error.name : String(error)),
  );

test.for(KEYS_BY_ENV.production)(
  "the CI role can neither sign with nor read $keyid",
  async (key) => {
    const KeyId = aliasArn(specOf(key.keyid).alias);
    expect(
      await refusal(
        client.send(
          new SignCommand({
            KeyId,
            Message: message,
            MessageType: "RAW",
            SigningAlgorithm: "ED25519_SHA_512",
          }),
        ),
      ),
    ).toBe("AccessDeniedException");
    expect(await refusal(client.send(new GetPublicKeyCommand({ KeyId })))).toBe(
      "AccessDeniedException",
    );
  },
);
