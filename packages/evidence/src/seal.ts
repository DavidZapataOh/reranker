import { createHash } from "node:crypto";
import { type SystemTx, withSystem } from "@reranker/db";
import { captures, evidenceEntries, type evidenceEntryKind } from "@reranker/db/schema";
import { enqueue } from "@reranker/jobs";
import { InvalidInputError, NotFoundError } from "@reranker/jobs/errors";
import { Uuid } from "@reranker/schema";
import {
  type CaptureId,
  type DsseEnvelope,
  DsseEnvelopeSchema,
  type InTotoStatement,
  type ResourceDescriptor,
} from "@reranker/verify/format";
import { and, eq, sql } from "drizzle-orm";
import { getArtifact, putArtifact } from "./artifacts";
import { signEnvelope } from "./dsse";
import { requireEvidenceEnv } from "./env";
import { integrateJob } from "./jobs";
import { loadSigner } from "./signer";
import {
  buildCaptureStatement,
  buildNormalizationStatement,
  buildPlanStatement,
  type CapturePredicateInput,
} from "./statement";

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
// Every provider is called with a JSON body, and plans and parses are JSON documents.
const JSON_CONTENT_TYPE = "application/json";
const MAX_SMALLINT = 32_767;
const SHA256_HEX = /^[0-9a-f]{64}$/;

const sha256Hex = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const toBytea = (hex: string) => Buffer.from(hex, "hex");
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
  // Settles every write before failing, so no request outlives the call that started it.
  const signing = signStatement(statement);
  const settled = await Promise.allSettled([signing, ...artifacts]);
  const failed = settled.find((r): r is PromiseRejectedResult => r.status === "rejected");
  if (failed) throw failed.reason;
  const signed = await signing;
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

type EntryKey = {
  ref: string;
  kind: (typeof evidenceEntryKind.enumValues)[number];
  revision: number;
};
type EntryRow = { envelopeSha256: Buffer; normalizedSha256: Buffer | null };

async function findEntry(tx: SystemTx, key: EntryKey): Promise<EntryRow | undefined> {
  const [row] = await tx
    .select({
      envelopeSha256: evidenceEntries.envelopeSha256,
      normalizedSha256: evidenceEntries.normalizedSha256,
    })
    .from(evidenceEntries)
    .where(
      and(
        eq(evidenceEntries.ref, key.ref),
        eq(evidenceEntries.kind, key.kind),
        eq(evidenceEntries.revision, key.revision),
      ),
    );
  return row;
}

/** The stored entry for `key`: ours, or the one a concurrent seal of the same key committed first. */
async function insertEntry(
  tx: SystemTx,
  key: EntryKey,
  envelopeSha256: string,
  normalizedSha256: string | null,
): Promise<EntryRow> {
  const [inserted] = await tx
    .insert(evidenceEntries)
    .values({
      ...key,
      envelopeSha256: toBytea(envelopeSha256),
      normalizedSha256: normalizedSha256 === null ? null : toBytea(normalizedSha256),
    })
    .onConflictDoNothing()
    .returning({
      envelopeSha256: evidenceEntries.envelopeSha256,
      normalizedSha256: evidenceEntries.normalizedSha256,
    });
  const row = inserted ?? (await findEntry(tx, key));
  if (!row) throw new Error(`Evidence entry ${key.kind} ${key.ref} vanished after a conflict`);
  return row;
}

/** Stores and signs the frozen plan of a measurement, once per measurement. */
export async function sealPlan(
  input: { measurementId: string; planBytes: Uint8Array },
  opts: { tx: SystemTx },
): Promise<{ planSha256: string; envelopeSha256: string }> {
  const { measurementId, planBytes } = input;
  if (!Uuid.safeParse(measurementId).success) {
    throw new InvalidInputError("measurementId must be a UUID");
  }
  const key: EntryKey = { ref: measurementId, kind: "plan", revision: 0 };
  const planSha256 = sha256Hex(planBytes);
  // A sealed plan is frozen: the same plan is a retry, another one is a bug upstream.
  const samePlan = async (row: EntryRow) => {
    const envelopeSha256 = toHex(row.envelopeSha256);
    const { statement } = await readStatement(envelopeSha256);
    if (subjectDigest(statement, "plan") !== planSha256) {
      throw new InvalidInputError(`Measurement ${measurementId} already sealed another plan`);
    }
    return { planSha256, envelopeSha256 };
  };
  const existing = await findEntry(opts.tx, key);
  if (existing) return samePlan(existing);
  const origin = logOrigin();
  const signedAt = new Date();
  const signed = await signAndStore(buildPlanStatement({ measurementId, planSha256, signedAt }), [
    putArtifact("plans", planBytes, { contentType: JSON_CONTENT_TYPE }),
  ]);
  const stored = await insertEntry(opts.tx, key, signed.envelopeSha256, null);
  if (toHex(stored.envelopeSha256) !== signed.envelopeSha256) return samePlan(stored);
  await scheduleIntegration(origin, signedAt);
  return { planSha256, envelopeSha256: signed.envelopeSha256 };
}

/**
 * Signs a newer parser's reading of a capture as its own log entry; the raw bytes and the
 * original seal never change. One entry per capture and parser version.
 */
export async function sealReparse(
  input: { captureId: CaptureId; normalized: Normalized },
  opts: { tx: SystemTx },
): Promise<{ normalizedSha256: string; envelopeSha256: string }> {
  const { captureId, normalized } = input;
  checkParserVersion(normalized.parserVersion);
  const key: EntryKey = { ref: captureId, kind: "reparse", revision: normalized.parserVersion };
  const normalizedSha256 = sha256Hex(normalized.json);
  // Parsers are deterministic: the same version yielding other bytes is a bug, never a revision.
  const sameParse = (row: EntryRow) => {
    if (row.normalizedSha256 === null || toHex(row.normalizedSha256) !== normalizedSha256) {
      throw new InvalidInputError(
        `Capture ${captureId} parser ${normalized.parserVersion} already produced other output`,
      );
    }
    return { normalizedSha256, envelopeSha256: toHex(row.envelopeSha256) };
  };
  const existing = await findEntry(opts.tx, key);
  if (existing) return sameParse(existing);
  const capture = await captureRow(opts.tx, captureId);
  if (!capture) throw new NotFoundError(`Capture ${captureId} does not exist`);
  const captureEnvelopeSha256 = toHex(capture.envelopeSha256);
  const { statement: original } = await readStatement(captureEnvelopeSha256);
  const origin = logOrigin();
  const signedAt = new Date();
  const statement = buildNormalizationStatement({
    captureId,
    captureEnvelopeSha256,
    rawSha256: subjectDigest(original, "raw"),
    normalizedSha256,
    parserVersion: normalized.parserVersion,
    signedAt,
  });
  const signed = await signAndStore(statement, [
    putArtifact("normalized", normalized.json, { contentType: JSON_CONTENT_TYPE }),
  ]);
  const stored = await insertEntry(opts.tx, key, signed.envelopeSha256, normalizedSha256);
  if (toHex(stored.envelopeSha256) !== signed.envelopeSha256) return sameParse(stored);
  await scheduleIntegration(origin, signedAt);
  return { normalizedSha256, envelopeSha256: signed.envelopeSha256 };
}

/**
 * Queues a statement signed elsewhere (`signStatement`) for the log, in the caller's transaction.
 * The caller stores the envelope with `putArtifact('envelopes', …)` first.
 */
export async function requestLogInclusion(
  entry: { ref: string; kind: "consent" | "key" | "regime" | "extraction"; envelopeSha256: string },
  opts: { tx: SystemTx },
): Promise<void> {
  if (!SHA256_HEX.test(entry.envelopeSha256)) {
    throw new InvalidInputError("envelopeSha256 must be a lowercase hex SHA-256 digest");
  }
  if (entry.ref.length === 0) throw new InvalidInputError("An evidence entry needs a ref");
  const origin = logOrigin();
  const key: EntryKey = { ref: entry.ref, kind: entry.kind, revision: 0 };
  const stored = await insertEntry(opts.tx, key, entry.envelopeSha256, null);
  if (toHex(stored.envelopeSha256) !== entry.envelopeSha256) {
    throw new InvalidInputError(
      `${entry.kind} ${entry.ref} is already logged with another envelope`,
    );
  }
  await scheduleIntegration(origin, new Date());
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

/** The newest normalized reading of a capture: its highest reparse, else its original parse. */
export async function latestNormalized(
  captureId: CaptureId,
): Promise<{ sha256: string; parserVersion: number } | null> {
  const { rows } = await withSystem(
    "evidence.latest_normalized",
    (tx) =>
      tx.execute<{
        normalized_sha256: Buffer | null;
        parser_version: number | null;
        reparse_sha256: Buffer | null;
        revision: number | null;
      }>(sql`
        select c.normalized_sha256, c.parser_version, r.normalized_sha256 as reparse_sha256, r.revision
        from public_panel.captures c
        left join lateral (
          select e.normalized_sha256, e.revision
          from public_panel.evidence_entries e
          where e.ref = c.id and e.kind = 'reparse'
          order by e.revision desc
          limit 1
        ) r on true
        where c.id = ${captureId}`),
    { readOnly: true },
  );
  const row = rows[0];
  if (!row) return null;
  if (row.reparse_sha256 !== null && row.revision !== null) {
    return { sha256: toHex(row.reparse_sha256), parserVersion: row.revision };
  }
  if (row.normalized_sha256 === null) return null;
  if (row.parser_version === null) {
    throw new Error(`Capture ${captureId} has a normalized digest without a parser version`);
  }
  return { sha256: toHex(row.normalized_sha256), parserVersion: row.parser_version };
}
