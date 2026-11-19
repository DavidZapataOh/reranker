import { sha256 } from "@noble/hashes/sha2.js";
import { fetchArtifact, isTooLarge, readCapped } from "./artifacts";
import type { HeaderCache, HeaderSource } from "./bitcoin";
import { withTimeout } from "./bitcoin";
import { type DateCheck, verifyOtsDate } from "./date";
import { type Check, verifyEnvelope } from "./dsse";
import {
  ARTIFACTS_ORIGIN,
  type CaptureStatementV1,
  type EvidenceBundleV1,
  EvidenceBundleV1Schema,
  envelopeBytes,
  isCaptureId,
  LOG_ORIGIN,
  leafHash,
} from "./format/index";
import { acceptsKeyAt, checkKeyConsistency } from "./keys-consistency";
import { verifyConsistency, verifyInclusion } from "./merkle";
import { parseSignedNote, verifyCheckpoint } from "./note";
import { TRUSTED_KEYS, type TrustedKey } from "./trust/keys";

export type Verdict =
  | "intact_dated"
  | "intact_dating"
  | "valid_content_removed"
  | "mismatch"
  | "untrusted_signature"
  | "not_found"
  | "incomplete";

export interface VerifyOptions {
  fetch?: typeof fetch;
  trustedKeys?: readonly TrustedKey[];
  bitcoinHeaderSources?: readonly HeaderSource[];
  headerCache?: HeaderCache;
  skipKeyConsistency?: boolean;
  signal?: AbortSignal;
  /** Where a non-production deployment serves bundles, artifacts and its log; never the bundle's. */
  origins?: { bundles?: string; artifacts?: string; log?: string };
}

type Checks = {
  signature: Check;
  content: Record<"raw" | "normalized", Check>;
  log: Check;
  consistency: Check;
  date: Check & { datedBefore?: string; bitcoinHeight?: number };
  keys: Check & { matches: number; of: number };
};

export interface VerificationReport {
  verdict: Verdict;
  checks: Checks;
  statement?: CaptureStatementV1;
  bundle?: EvidenceBundleV1;
  /** Seconds until a capture that is signed but not in the log yet is worth asking for again. */
  retryAfter?: number;
}

export const MAX_BUNDLE_BYTES = 256 * 1024;
const BUNDLE_TIMEOUT_MS = 5_000;
const BUNDLES_ORIGIN = "https://reranker.co";
const PASS: Check = { status: "pass" };
// A note signed by a key we do not pin, or by a pinned one at a time it was not trusted.
const UNTRUSTED_LOG = new Set(["untrusted_log_key", "bad_signature", "key_not_trusted_then"]);

const fromBase64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

function unverified(verdict: Verdict, check: Check, extra: Partial<VerificationReport> = {}) {
  const checks: Checks = {
    signature: check,
    content: { raw: check, normalized: check },
    log: check,
    consistency: check,
    date: check,
    keys: { ...check, matches: 0, of: 3 },
  };
  return { verdict, checks, ...extra } satisfies VerificationReport;
}

/** Mapped in this order, so a positive verdict never stands on a failed signature, digest or proof. */
export function toVerdict(c: Checks): Verdict {
  const all = [c.content.raw, c.content.normalized, c.log, c.consistency];
  const untrustedLog = [c.log, c.consistency].some((x) => UNTRUSTED_LOG.has(x.detail ?? ""));
  if (c.signature.status === "fail" || untrustedLog) return "untrusted_signature";
  if (all.some((x) => x.status === "fail")) return "mismatch";
  if (all.some((x) => x.status === "unavailable")) return "incomplete";
  if (c.content.raw.status === "removed") return "valid_content_removed";
  return c.date.status === "pass" ? "intact_dated" : "intact_dating";
}

/** The checkpoint's size and root, and which pinned log key signed it. */
function openCheckpoint(note: string, keys: readonly TrustedKey[], origin: string) {
  const opened = verifyCheckpoint(note, keys, origin);
  if (!("root" in opened)) return { check: opened.check };
  const signer = keys.find(
    (k) => k.purpose === "log" && verifyCheckpoint(note, [k], origin).check.status === "pass",
  );
  return { ...opened, signer: signer as TrustedKey };
}

async function contentCheck(
  kind: "raw" | "normalized",
  bundle: EvidenceBundleV1,
  statement: CaptureStatementV1 | null,
  opts: { fetch: typeof fetch; signal?: AbortSignal; origin?: string },
): Promise<Check> {
  if (!statement) return { status: "unavailable", detail: "unsigned" };
  // Only the signed statement's digest counts; the bundle's copy must merely agree with it.
  const signed = statement.subject.find((s) => s.name === kind)?.digest.sha256;
  const listed = bundle.artifacts[kind];
  if (signed === undefined && listed === undefined) return { status: "pass", detail: "absent" };
  if (signed === undefined || signed !== listed?.sha256) {
    return { status: "fail", detail: "digest_mismatch" };
  }
  if (listed.status === "removed") return { status: "removed", detail: listed.reason };
  return (await fetchArtifact(kind, signed, opts)).check;
}

// envelopeBytes refuses strings JCS could encode differently elsewhere; such an envelope has no leaf.
function envelopeLeaf(bundle: EvidenceBundleV1): Uint8Array | null {
  try {
    return leafHash(sha256(envelopeBytes(bundle.envelope)));
  } catch {
    return null;
  }
}

function logCheck(bundle: EvidenceBundleV1, keys: readonly TrustedKey[], origin: string) {
  const checkpoint = openCheckpoint(bundle.checkpoint, keys, origin);
  const latest = openCheckpoint(bundle.latest.checkpoint, keys, origin);
  const { inclusion } = bundle;
  let log: Check = checkpoint.check;
  let consistency: Check = latest.check;
  if ("root" in checkpoint) {
    if (inclusion.log !== origin) log = { status: "fail", detail: "origin_mismatch" };
    else if (inclusion.tree_size !== checkpoint.size)
      log = { status: "fail", detail: "size_mismatch" };
    else {
      const leaf = envelopeLeaf(bundle);
      const proof = inclusion.hashes.map(fromBase64);
      // Size and root come from the signed checkpoint: a proof can also hold for another size.
      const included =
        leaf !== null &&
        verifyInclusion({
          index: inclusion.index,
          size: checkpoint.size,
          leaf,
          proof,
          root: checkpoint.root,
        });
      log = included ? PASS : { status: "fail", detail: "not_included" };
    }
  }
  if ("root" in checkpoint && "root" in latest) {
    const consistent = verifyConsistency({
      size1: checkpoint.size,
      size2: latest.size,
      root1: checkpoint.root,
      root2: latest.root,
      proof: bundle.latest.consistency.map(fromBase64),
    });
    consistency = consistent ? PASS : { status: "fail", detail: "inconsistent" };
  }
  const signer = "signer" in checkpoint ? checkpoint.signer : null;
  const latestSigner = "signer" in latest ? latest.signer : null;
  return { log, consistency, signer, latestSigner };
}

function dateCheck(bundle: EvidenceBundleV1, opts: VerifyOptions): Promise<DateCheck> {
  const note = parseSignedNote(bundle.checkpoint);
  if (!note) return Promise.resolve({ status: "fail", detail: "malformed" });
  return verifyOtsDate({
    checkpointDigest: sha256(new TextEncoder().encode(note.body)),
    ots: bundle.anchors.ots ? fromBase64(bundle.anchors.ots.proof) : null,
    ...(opts.fetch && { fetch: opts.fetch }),
    ...(opts.bitcoinHeaderSources && { sources: opts.bitcoinHeaderSources }),
    ...(opts.headerCache && { cache: opts.headerCache }),
    ...(opts.signal && { signal: opts.signal }),
  });
}

function parseBundle(input: unknown): EvidenceBundleV1 | VerificationReport {
  const invalid = unverified("incomplete", { status: "unavailable", detail: "invalid_bundle" });
  let value = input;
  if (typeof input === "string" || input instanceof Uint8Array) {
    // Checked before parsing. A string over the limit in UTF-16 units is over it in UTF-8 bytes too,
    // so only a shorter one is encoded to measure it.
    const tooLarge =
      input.length > MAX_BUNDLE_BYTES ||
      (typeof input === "string" && new TextEncoder().encode(input).length > MAX_BUNDLE_BYTES);
    if (tooLarge)
      return unverified("incomplete", { status: "unavailable", detail: "bundle_too_large" });
    try {
      value = JSON.parse(typeof input === "string" ? input : new TextDecoder().decode(input));
    } catch {
      return invalid;
    }
  }
  const parsed = EvidenceBundleV1Schema.safeParse(value);
  return parsed.success ? parsed.data : invalid;
}

/**
 * Checks a bundle — parsed, or the text or bytes of a bundle file — entirely on this side: the
 * capture signature, the artifacts behind the signed digests, the log inclusion and consistency
 * proofs, the Bitcoin date and the key's public copies, the network-bound ones in parallel.
 */
export async function verifyBundle(
  input: unknown,
  opts: VerifyOptions = {},
): Promise<VerificationReport> {
  const bundle = parseBundle(input);
  if ("verdict" in bundle) return bundle;
  const keys = opts.trustedKeys ?? TRUSTED_KEYS;
  const fetchImpl = opts.fetch ?? ((url, init) => fetch(url, init));
  const artifactOpts = {
    fetch: fetchImpl,
    origin: opts.origins?.artifacts ?? ARTIFACTS_ORIGIN,
    ...(opts.signal && { signal: opts.signal }),
  };

  const envelope = verifyEnvelope(bundle.envelope, keys);
  const statement = envelope.statement as CaptureStatementV1 | null;
  const captureKey = keys.find((k) => k.purpose === "capture" && k.keyid === envelope.keyid);
  const log = logCheck(bundle, keys, opts.origins?.log ?? LOG_ORIGIN);
  const [raw, normalized, date, keyCheck] = await Promise.all([
    contentCheck("raw", bundle, statement, artifactOpts),
    contentCheck("normalized", bundle, statement, artifactOpts),
    dateCheck(bundle, opts),
    opts.skipKeyConsistency
      ? { status: "unavailable" as const, detail: "skipped", matches: 0, of: 3 }
      : checkKeyConsistency(envelope.keyid ?? "", {
          fetch: fetchImpl,
          ...(opts.signal && { signal: opts.signal }),
        }),
  ]);

  // Anchored keys are judged at the time Bitcoin dates the checkpoint holding the capture.
  const anchoredAt = date.status === "pass" ? (date.datedBefore ?? null) : null;
  const untrustedThen: Check = { status: "fail", detail: "key_not_trusted_then" };
  let signature = envelope.check;
  if (statement && captureKey && !acceptsKeyAt(captureKey, anchoredAt)) signature = untrustedThen;
  const logResult = log.signer && !acceptsKeyAt(log.signer, anchoredAt) ? untrustedThen : log.log;
  const consistency =
    log.latestSigner && !acceptsKeyAt(log.latestSigner, null) ? untrustedThen : log.consistency;

  const checks: Checks = {
    signature,
    content: { raw, normalized },
    log: logResult,
    consistency,
    date,
    keys: keyCheck,
  };
  return { verdict: toVerdict(checks), checks, ...(statement && { statement }), bundle };
}

/**
 * Downloads a capture's bundle from the fixed origin and verifies it. A 404 with `Retry-After` is a
 * capture signed but not in the log yet, which the caller asks for again after that delay.
 */
export async function verifyCapture(
  captureId: string,
  opts: VerifyOptions = {},
): Promise<VerificationReport> {
  const missing = { status: "unavailable", detail: "not_found" } as const;
  if (!isCaptureId(captureId)) return unverified("not_found", missing);
  const fetchImpl = opts.fetch ?? ((url, init) => fetch(url, init));
  const timeout = withTimeout(opts.signal, BUNDLE_TIMEOUT_MS);
  let bytes: Uint8Array;
  try {
    const url = `${opts.origins?.bundles ?? BUNDLES_ORIGIN}/api/evidence/bundles/${captureId}`;
    const response = await fetchImpl(url, { signal: timeout.signal });
    if (response.status === 404) {
      await response.body?.cancel();
      const retryAfter = Number.parseInt(response.headers.get("retry-after") ?? "", 10);
      if (!Number.isSafeInteger(retryAfter)) return unverified("not_found", missing);
      const report = unverified("incomplete", { status: "pending" }, { retryAfter });
      report.checks.log = { status: "pending", detail: "not_logged" };
      return report;
    }
    if (!response.ok) {
      await response.body?.cancel();
      return unverified("incomplete", { status: "unavailable", detail: `http_${response.status}` });
    }
    bytes = await readCapped(response, MAX_BUNDLE_BYTES);
  } catch (error) {
    const detail = isTooLarge(error) ? "bundle_too_large" : "network";
    return unverified("incomplete", { status: "unavailable", detail });
  } finally {
    timeout.clear();
  }
  return verifyBundle(bytes, opts);
}
