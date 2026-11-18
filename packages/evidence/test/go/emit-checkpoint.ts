// Prints a freshly signed checkpoint and its verifier key for `go run . note-verify`.
import { createHash } from "node:crypto";
import { noteVerifierKey } from "@reranker/verify/trust";
import { formatCheckpoint, signCheckpoint } from "../../src/log/checkpoint";
import { localSigner } from "../support/local-signer";

const origin = "log.reranker.co/captures/2026";
const signer = localSigner("rr-log-test-1");
const root = new Uint8Array(createHash("sha256").update("reranker checkpoint").digest());
const note = await signCheckpoint(formatCheckpoint({ origin, size: 1240, root }), signer, origin);
process.stdout.write(JSON.stringify({ vkey: noteVerifierKey(origin, signer.publicKey), note }));
