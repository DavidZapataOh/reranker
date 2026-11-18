import { createHash } from "node:crypto";
import { type SystemTx, withSystem } from "@reranker/db";
import { captures } from "@reranker/db/schema";
import { enqueue } from "@reranker/jobs";
import { InvalidInputError, NotFoundError } from "@reranker/jobs/errors";
import {
  type CaptureId,
  type DsseEnvelope,
  DsseEnvelopeSchema,
  type InTotoStatement,
  type ResourceDescriptor,
} from "@reranker/verify/format";
import { eq } from "drizzle-orm";
import { getArtifact, putArtifact } from "./artifacts";
import { signEnvelope } from "./dsse";
import { requireEvidenceEnv } from "./env";
import { integrateJob } from "./jobs";
import { loadSigner } from "./signer";
import { buildCaptureStatement, type CapturePredicateInput } from "./statement";

export type { CapturePredicateInput } from "./statement";

type Normalized = { json: Uint8Array; parserVersion: number };

export interface SealCaptureInput {
  captureId: CaptureId;
  responseBytes: Uint8Array;
  responseContentType: string;
  requestBytes: Uint8Array;
  normalized: Normalized | null;
  predicate: CapturePredicateInput;
}

export interface SealedCapture {
  captureId: CaptureId;
  envelopeSha256: string;
  rawSha256: string;
  requestSha256: string;
  normalizedSha256: string | null;
  keyid: string;
  signedAt: Date;
}

type Statement = InTotoStatement<string, { time: { worker_utc: string } }>;

const ENVELOPE_CONTENT_TYPE = "application/vnd.dsse.envelope.v1+json";
// Every provider is called with a JSON body, and parses are JSON documents.
const JSON_CONTENT_TYPE = "application/json";
const MAX_SMALLINT = 32_767;

const sha256Hex = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const toHex = (bytes: Buffer) => bytes.toString("hex");

/** Signs a statement with the current capture key without storing it anywhere. */
export async function signStatement<T extends string, P>(
  statement: InTotoStatement<T, P>,
): Promise<{ envelope: DsseEnvelope; envelopeBytes: Uint8Array; envelopeSha256: string }> {
  const signer = await loadSigner("capture");
  const payload = new TextEncoder().encode(JSON.stringify(statement));
  const { envelope, bytes, sha256 } = await signEnvelope(payload, [signer]);
  return { envelope, envelopeBytes: bytes, envelopeSha256: sha256 };
}

function keyidOf(envelope: DsseEnvelope): string {
  const [first] = envelope.signatures;
  if (!first) throw new Error("A DSSE envelope without signatures");
  return first.keyid;
}

// Signs and stores the envelope only after the artifacts it names are stored, so every public
// envelope resolves; artifacts orphaned by a later failure are harmless, being content-addressed.
async function signAndStore(
  statement: InTotoStatement<string, unknown>,
  artifacts: Promise<unknown>[],
): Promise<{ envelopeSha256: string; keyid: string }> {
  const [signed] = await Promise.all([signStatement(statement), ...artifacts]);
  await putArtifact("envelopes", signed.envelopeBytes, { contentType: ENVELOPE_CONTENT_TYPE });
  return { envelopeSha256: signed.envelopeSha256, keyid: keyidOf(signed.envelope) };
}

async function readStatement(
  envelopeSha256: string,
): Promise<{ keyid: string; statement: Statement }> {
  const bytes = await getArtifact("envelopes", envelopeSha256);
  if (bytes === null) throw new NotFoundError(`Envelope ${envelopeSha256} is missing or altered`);
  const envelope = DsseEnvelopeSchema.parse(JSON.parse(new TextDecoder().decode(bytes)));
  const statement: Statement = JSON.parse(Buffer.from(envelope.payload, "base64").toString("utf8"));
  return { keyid: keyidOf(envelope), statement };
}

function subjectDigest(statement: Statement, name: string): string {
  const subject = statement.subject.find((s: ResourceDescriptor) => s.name === name);
  if (!subject) throw new Error(`Signed statement has no ${name} subject`);
  return subject.digest.sha256;
}

// Read before any write, so a deployment without a log signs and stores nothing.
const logOrigin = () => requireEvidenceEnv("EVIDENCE_LOG_ORIGIN").EVIDENCE_LOG_ORIGIN;

// Integration runs at most once a minute, a minute after the first seal that needs it.
async function scheduleIntegration(origin: string, now: Date): Promise<void> {
  const minute = Math.floor(now.getTime() / 60_000);
  await enqueue(
    integrateJob,
    { origin },
    { dedupeKey: `int-${minute}`, runAt: new Date((minute + 1) * 60_000) },
  );
}

function checkParserVersion(parserVersion: number): void {
  if (!Number.isInteger(parserVersion) || parserVersion < 0 || parserVersion > MAX_SMALLINT) {
    throw new InvalidInputError(`parserVersion must be an integer from 0 to ${MAX_SMALLINT}`);
  }
}

async function captureRow(tx: SystemTx, captureId: CaptureId) {
  const [row] = await tx
    .select({
      envelopeSha256: captures.envelopeSha256,
      normalizedSha256: captures.normalizedSha256,
    })
    .from(captures)
    .where(eq(captures.id, captureId));
  return row;
}

/**
 * Stores a capture's artifacts and signs its statement. It inserts no row: the caller writes the
 * capture with the returned digests in the same `tx`, so a capture never exists unsealed. A retry
 * whose capture row is already visible returns that row's seal instead of signing again.
 */
export async function sealCapture(
  input: SealCaptureInput,
  opts: { tx: SystemTx },
): Promise<SealedCapture> {
  const existing = await captureRow(opts.tx, input.captureId);
  if (existing) {
    const envelopeSha256 = toHex(existing.envelopeSha256);
    const { keyid, statement } = await readStatement(envelopeSha256);
    return {
      captureId: input.captureId,
      envelopeSha256,
      rawSha256: subjectDigest(statement, "raw"),
      requestSha256: subjectDigest(statement, "request"),
      normalizedSha256: existing.normalizedSha256 ? toHex(existing.normalizedSha256) : null,
      keyid,
      signedAt: new Date(statement.predicate.time.worker_utc),
    };
  }
  if (input.normalized) checkParserVersion(input.normalized.parserVersion);
  const origin = logOrigin();
  const signedAt = new Date();
  const rawSha256 = sha256Hex(input.responseBytes);
  const requestSha256 = sha256Hex(input.requestBytes);
  const normalizedSha256 = input.normalized ? sha256Hex(input.normalized.json) : null;
  const statement = buildCaptureStatement({
    captureId: input.captureId,
    rawSha256,
    requestSha256,
    normalizedSha256,
    predicate: input.predicate,
    signedAt,
  });
  const artifacts = [
    putArtifact("raw", input.responseBytes, { contentType: input.responseContentType }),
    putArtifact("request", input.requestBytes, { contentType: JSON_CONTENT_TYPE }),
  ];
  if (input.normalized) {
    artifacts.push(
      putArtifact("normalized", input.normalized.json, { contentType: JSON_CONTENT_TYPE }),
    );
  }
  const { envelopeSha256, keyid } = await signAndStore(statement, artifacts);
  await scheduleIntegration(origin, signedAt);
  return {
    captureId: input.captureId,
    envelopeSha256,
    rawSha256,
    requestSha256,
    normalizedSha256,
    keyid,
    signedAt,
  };
}

/** The exact response bytes of a capture, checked against the digest its signed statement holds. */
export async function readRaw(captureId: CaptureId): Promise<Uint8Array> {
  const capture = await withSystem("evidence.read_raw", (tx) => captureRow(tx, captureId), {
    readOnly: true,
  });
  if (!capture) throw new NotFoundError(`Capture ${captureId} does not exist`);
  const { statement } = await readStatement(toHex(capture.envelopeSha256));
  const rawSha256 = subjectDigest(statement, "raw");
  const raw = await getArtifact("raw", rawSha256);
  if (raw === null) throw new NotFoundError(`Raw response ${rawSha256} is missing or altered`);
  return raw;
}
