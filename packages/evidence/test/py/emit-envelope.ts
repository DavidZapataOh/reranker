// Prints a freshly signed envelope and its public key for verify_envelope.py.
import { signEnvelope } from "../../src/dsse";
import { localSigner } from "../support/local-signer";

const signer = localSigner("rr-capture-test-1-ed25519");
const statement = JSON.stringify({
  _type: "https://in-toto.io/Statement/v1",
  subject: [
    {
      name: "raw",
      digest: { sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" },
    },
  ],
  predicateType: "https://reranker.co/attestations/ai-answer-capture/v1",
  predicate: { answer: "Clínica dental en Medellín ✓" },
});
const { envelope } = await signEnvelope(new TextEncoder().encode(statement), [signer]);
process.stdout.write(
  JSON.stringify({ publicKey: Buffer.from(signer.publicKey).toString("base64"), envelope }),
);
