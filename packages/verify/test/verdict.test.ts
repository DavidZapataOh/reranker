import { readFileSync } from "node:fs";
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, concatBytes } from "@noble/hashes/utils.js";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { verifyOtsDate } from "../src/date";
import {
  ARTIFACTS_ORIGIN,
  type CaptureStatementV1,
  DSSE_PAYLOAD_TYPE,
  type EvidenceBundleV1,
  envelopeBytes,
  LOG_ORIGIN,
  leafHash,
  nodeHash,
  pae,
  serializeDetachedOts,
} from "../src/format/index";
import { noteKeyId, type TrustedKey } from "../src/trust/keys";
import { type Verdict, type VerifyOptions, verifyBundle, verifyCapture } from "../src/verdict";

vi.mock("../src/date", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/date")>();
  return { ...actual, verifyOtsDate: vi.fn(actual.verifyOtsDate) };
});

const text = new TextEncoder();
const base64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const read = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const HEADERS: Record<string, { hash: string; header: string }> = JSON.parse(
  read("bitcoin-headers.json"),
);

const secret = (n: number) => new Uint8Array(32).fill(n);
const key = (keyid: string, purpose: TrustedKey["purpose"], n: number): TrustedKey => ({
  keyid,
  purpose,
  env: "preview",
  alg: "Ed25519",
  publicKey: base64(ed25519.getPublicKey(secret(n))),
  custody: "aws-kms-hsm",
  // Before the recorded block the dated cases anchor in.
  validFrom: "2015-01-01T00:00:00Z",
  validTo: null,
  compromisedAfter: null,
});
const KEYS = [key("rr-capture-test", "capture", 1), key("rr-log-test", "log", 2)];

const raw = text.encode('{"output":"La Clínica Dental Sonrisa es una opción"}');
const normalized = text.encode('{"answer_text":"La Clínica Dental Sonrisa es una opción"}');

// RFC 6962 §2.1: MTH, PATH and PROOF over leaf hashes, written from the definitions.
const split = (n: number) => {
  let k = 1;
  while (k * 2 < n) k *= 2;
  return k;
};
const mth = (l: Uint8Array[]): Uint8Array =>
  l.length === 1
    ? (l[0] as Uint8Array)
    : nodeHash(mth(l.slice(0, split(l.length))), mth(l.slice(split(l.length))));
const path = (m: number, l: Uint8Array[]): Uint8Array[] => {
  if (l.length === 1) return [];
  const k = split(l.length);
  return m < k
    ? [...path(m, l.slice(0, k)), mth(l.slice(k))]
    : [...path(m - k, l.slice(k)), mth(l.slice(0, k))];
};
const subproof = (m: number, l: Uint8Array[], whole: boolean): Uint8Array[] => {
  if (m === l.length) return whole ? [] : [mth(l)];
  const k = split(l.length);
  return m <= k
    ? [...subproof(m, l.slice(0, k), whole), mth(l.slice(k))]
    : [...subproof(m - k, l.slice(k), false), mth(l.slice(0, k))];
};

function signNote(size: number, root: Uint8Array, n = 2, origin = LOG_ORIGIN) {
  const body = `${origin}\n${size}\n${base64(root)}\n`;
  const sig = ed25519.sign(text.encode(body), secret(n));
  const id = noteKeyId(origin, ed25519.getPublicKey(secret(n)));
  return `${body}\n— ${origin} ${base64(concatBytes(id, sig))}\n`;
}
const noteBody = (note: string) => note.slice(0, note.lastIndexOf("\n\n") + 1);

function build(o: { statement?: (s: CaptureStatementV1) => void; captureKey?: number } = {}) {
  const statement: CaptureStatementV1 = JSON.parse(read("statement.capture.json"));
  for (const subject of statement.subject) {
    if (subject.name === "raw") subject.digest.sha256 = bytesToHex(sha256(raw));
    if (subject.name === "normalized") subject.digest.sha256 = bytesToHex(sha256(normalized));
  }
  o.statement?.(statement);
  const body = text.encode(JSON.stringify(statement));
  const sig = ed25519.sign(pae(DSSE_PAYLOAD_TYPE, body), secret(o.captureKey ?? 1));
  const envelope = {
    payloadType: DSSE_PAYLOAD_TYPE,
    payload: base64(body),
    signatures: [{ keyid: "rr-capture-test", sig: base64(sig) }],
  } as const;
  const leaves = Array.from({ length: 7 }, (_, i) => leafHash(Uint8Array.of(i)));
  leaves[3] = leafHash(
    sha256(envelopeBytes({ ...envelope, signatures: [...envelope.signatures] })),
  );
  const checkpoint = signNote(5, mth(leaves.slice(0, 5)));
  const digest = sha256(text.encode(noteBody(checkpoint)));
  const ots = serializeDetachedOts(digest, {
    msg: digest,
    attestations: [{ kind: "bitcoin", height: 358_391 }],
    ops: [],
  });
  return {
    version: 1,
    capture_id: statement.predicate.capture_id,
    envelope: { ...envelope, signatures: [...envelope.signatures] },
    artifacts: {
      raw: { sha256: bytesToHex(sha256(raw)), status: "available" },
      normalized: { sha256: bytesToHex(sha256(normalized)), status: "available" },
    },
    inclusion: {
      log: LOG_ORIGIN,
      index: 3,
      tree_size: 5,
      hashes: path(3, leaves.slice(0, 5)).map(base64),
    },
    checkpoint,
    latest: {
      checkpoint: signNote(7, mth(leaves)),
      consistency: subproof(5, leaves, true).map(base64),
    },
    anchors: { ots: { status: "confirmed", proof: base64(ots), bitcoin_height: 358_391 }, tsr: [] },
    rekor: null,
    plan: null,
    tlsn: null,
  } satisfies EvidenceBundleV1 as EvidenceBundleV1;
}

const realBundle = build();
const edit = (f: (b: EvidenceBundleV1) => void) => {
  const b = structuredClone(realBundle);
  f(b);
  return b;
};

type Reply = Uint8Array | Response | Error | (() => Promise<Response>);
const MEMPOOL = "https://mempool.space/api";
const BLOCKSTREAM = "https://blockstream.info/api";

/** Our artifact origin and both explorers serving recorded blocks; anything else is a 404. */
function network(over: Record<string, Reply> = {}) {
  const routes: Record<string, Reply> = {
    [`${ARTIFACTS_ORIGIN}/raw/${bytesToHex(sha256(raw))}`]: raw,
    [`${ARTIFACTS_ORIGIN}/normalized/${bytesToHex(sha256(normalized))}`]: normalized,
  };
  for (const api of [MEMPOOL, BLOCKSTREAM]) {
    for (const [height, { hash, header }] of Object.entries(HEADERS)) {
      routes[`${api}/block-height/${height}`] = text.encode(hash);
      routes[`${api}/block/${hash}/header`] = text.encode(header);
    }
  }
  Object.assign(routes, over);
  const calls: string[] = [];
  const f = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    const reply = routes[url];
    if (reply instanceof Error) throw reply;
    if (reply instanceof Response) return reply;
    if (typeof reply === "function") return reply();
    if (reply === undefined) return new Response("not found", { status: 404 });
    return new Response(reply as Uint8Array<ArrayBuffer>);
  });
  return Object.assign(f as unknown as typeof fetch, { calls });
}

const opts = (over: Partial<VerifyOptions> = {}): VerifyOptions => ({
  fetch: network(),
  trustedKeys: KEYS,
  skipKeyConsistency: true,
  headerCache: { get: () => null, set: () => {} },
  ...over,
});
const rawUrl = `${ARTIFACTS_ORIGIN}/raw/${bytesToHex(sha256(raw))}`;
const flipByte = raw.map((b, i) => (i === 0 ? b ^ 1 : b));
const DATED = {
  status: "pass",
  bitcoinHeight: 358_391,
  datedBefore: "2015-05-28T15:41:18.000Z",
} as const;

beforeEach(() => {
  vi.mocked(verifyOtsDate).mockClear();
});
afterEach(() => {
  vi.restoreAllMocks();
});

type Row = [string, Verdict, EvidenceBundleV1, Record<string, Reply>?, boolean?];

test.each<Row>([
  ["a sealed capture dated in Bitcoin", "intact_dated", realBundle, {}, true],
  [
    "ots still pending",
    "intact_dating",
    edit((b) => {
      b.anchors.ots = null;
    }),
  ],
  ["one byte changed in raw", "mismatch", realBundle, { [rawUrl]: flipByte }],
  [
    "one byte changed in the payload",
    "untrusted_signature",
    edit((b) => {
      const payload = Uint8Array.from(atob(b.envelope.payload), (c) => c.charCodeAt(0));
      payload[40] = (payload[40] as number) ^ 1;
      b.envelope.payload = base64(payload);
    }),
  ],
  [
    "altered inclusion proof",
    "mismatch",
    edit((b) => {
      b.inclusion.hashes.reverse();
    }),
  ],
  [
    "checkpoint signed by another key",
    "untrusted_signature",
    edit((b) => {
      b.checkpoint = signNote(5, sha256(text.encode("x")), 9);
    }),
  ],
  ["ots commitment not in the header", "intact_dating", realBundle],
  [
    "raw removed",
    "valid_content_removed",
    edit((b) => {
      b.artifacts.raw = {
        sha256: b.artifacts.raw.sha256,
        status: "removed",
        removed_at: "2026-12-01T10:15:00.000Z",
        reason: "personal_data_request",
      };
    }),
  ],
  [
    "artifacts unreachable",
    "incomplete",
    realBundle,
    { [rawUrl]: new TypeError("Failed to fetch") },
  ],
])("%s → %s", async (_, verdict, bundle, routes = {}, dated = false) => {
  if (dated) vi.mocked(verifyOtsDate).mockResolvedValueOnce(DATED);
  const report = await verifyBundle(bundle, opts({ fetch: network(routes) }));
  expect(report.verdict).toBe(verdict);
});

test("a dated report carries the block and dates the checkpoint body, not the note", async () => {
  vi.mocked(verifyOtsDate).mockResolvedValueOnce(DATED);
  const report = await verifyBundle(realBundle, opts());
  expect(report.checks).toMatchObject({
    signature: { status: "pass" },
    content: { raw: { status: "pass" }, normalized: { status: "pass" } },
    log: { status: "pass" },
    consistency: { status: "pass" },
    date: DATED,
  });
  expect(report.statement?.predicate.capture_id).toBe(realBundle.capture_id);
  expect(vi.mocked(verifyOtsDate).mock.calls[0]?.[0].checkpointDigest).toEqual(
    sha256(text.encode(noteBody(realBundle.checkpoint))),
  );
});

test("a digest in the bundle that the signed statement does not hold is a mismatch", async () => {
  const bundle = edit((b) => {
    b.artifacts.raw.sha256 = bytesToHex(sha256(flipByte));
  });
  const fetch = network({ [`${ARTIFACTS_ORIGIN}/raw/${bytesToHex(sha256(flipByte))}`]: flipByte });
  const report = await verifyBundle(bundle, opts({ fetch }));
  expect(report.verdict).toBe("mismatch");
  expect(report.checks.content.raw).toEqual({ status: "fail", detail: "digest_mismatch" });
});

test("a capture without a normalized artifact checks raw only", async () => {
  const bundle = build({
    statement: (s) => {
      s.subject = s.subject.filter((x) => x.name !== "normalized");
    },
  });
  delete bundle.artifacts.normalized;
  const fetch = network();
  const report = await verifyBundle(bundle, opts({ fetch }));
  expect(report.verdict).toBe("intact_dating");
  expect(report.checks.content.normalized).toEqual({ status: "pass", detail: "absent" });
  expect(fetch.calls.some((u) => u.includes("/normalized/"))).toBe(false);
});

test("a compromised capture key is trusted only for signatures anchored before the compromise", async () => {
  const compromised = [
    { ...(KEYS[0] as TrustedKey), compromisedAfter: "2015-06-01T00:00:00Z" },
    KEYS[1] as TrustedKey,
  ];
  vi.mocked(verifyOtsDate).mockResolvedValueOnce(DATED);
  expect((await verifyBundle(realBundle, opts({ trustedKeys: compromised }))).verdict).toBe(
    "intact_dated",
  );
  const late = [
    { ...(KEYS[0] as TrustedKey), compromisedAfter: "2015-05-01T00:00:00Z" },
    KEYS[1] as TrustedKey,
  ];
  vi.mocked(verifyOtsDate).mockResolvedValueOnce(DATED);
  const report = await verifyBundle(realBundle, opts({ trustedKeys: late }));
  expect(report.verdict).toBe("untrusted_signature");
  expect(report.checks.signature).toEqual({ status: "fail", detail: "key_not_trusted_then" });
  // Not anchored yet: nothing proves the signature predates the compromise.
  expect((await verifyBundle(realBundle, opts({ trustedKeys: compromised }))).verdict).toBe(
    "untrusted_signature",
  );
});

test("a compromised log key cannot vouch for a checkpoint anchored after the compromise", async () => {
  const keys = [
    KEYS[0] as TrustedKey,
    { ...(KEYS[1] as TrustedKey), compromisedAfter: "2015-05-01T00:00:00Z" },
  ];
  vi.mocked(verifyOtsDate).mockResolvedValueOnce(DATED);
  const report = await verifyBundle(realBundle, opts({ trustedKeys: keys }));
  expect(report.verdict).toBe("untrusted_signature");
  expect(report.checks.log).toEqual({ status: "fail", detail: "key_not_trusted_then" });
});

test("a checkpoint of another size than the inclusion proof is a mismatch", async () => {
  const bundle = edit((b) => {
    b.inclusion.tree_size = 6;
  });
  expect((await verifyBundle(bundle, opts())).checks.log).toEqual({
    status: "fail",
    detail: "size_mismatch",
  });
});

test("a latest checkpoint the bundle's one is not a prefix of is a mismatch", async () => {
  const bundle = edit((b) => {
    b.latest.checkpoint = signNote(7, sha256(text.encode("fork")));
  });
  const report = await verifyBundle(bundle, opts());
  expect(report.verdict).toBe("mismatch");
  expect(report.checks.consistency).toEqual({ status: "fail", detail: "inconsistent" });
});

test("a bundle over 256 KB is rejected before JSON.parse", async () => {
  const parse = vi.spyOn(JSON, "parse");
  const report = await verifyBundle(`{"pad":"${"x".repeat(256 * 1024)}"}`, opts());
  expect(report.verdict).toBe("incomplete");
  expect(report.checks.signature).toEqual({ status: "unavailable", detail: "bundle_too_large" });
  expect(parse).not.toHaveBeenCalled();
});

test("an uploaded bundle file verifies like the parsed one", async () => {
  const report = await verifyBundle(text.encode(JSON.stringify(realBundle)), opts());
  expect(report.verdict).toBe("intact_dating");
  expect((await verifyBundle("{not json", opts())).verdict).toBe("incomplete");
});

test("an artifact over 2 MB is cut and fails", async () => {
  let pulled = 0;
  const endless = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulled += 64 * 1024;
      controller.enqueue(new Uint8Array(64 * 1024));
    },
  });
  const report = await verifyBundle(
    realBundle,
    opts({ fetch: network({ [rawUrl]: new Response(endless) }) }),
  );
  expect(report.checks.content.raw).toEqual({ status: "fail", detail: "too_large" });
  expect(report.verdict).toBe("mismatch");
  expect(pulled).toBeLessThan(3 * 1024 * 1024);
});

test("URLs inside a bundle are never fetched", async () => {
  const fetch = network();
  const tampered = edit((b) => {
    Object.assign(b.artifacts.raw, { url: "https://evil.example/raw" });
  });
  expect((await verifyBundle(tampered, opts({ fetch }))).verdict).toBe("incomplete");
  await verifyBundle(realBundle, opts({ fetch }));
  const fixed = [ARTIFACTS_ORIGIN, MEMPOOL, BLOCKSTREAM];
  expect(fetch.calls.length).toBeGreaterThan(0);
  expect(fetch.calls.filter((u) => !fixed.some((o) => u.startsWith(`${o}/`)))).toEqual([]);
});

test("the date check runs in parallel with content and log checks", async () => {
  // Every request is held until both the artifact and an explorer have been asked: run one after
  // the other, the second would never be asked and the check would hang.
  let release: () => void = () => {};
  const bothAsked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const asked = new Set<string>();
  const held = (url: string, reply: () => Response) => async () => {
    asked.add(url);
    if (asked.has(rawUrl) && asked.has(`${MEMPOOL}/block-height/358391`)) release();
    await Promise.race([bothAsked, new Promise((r) => setTimeout(r, 2_000))]);
    return reply();
  };
  const hash = HEADERS["358391"]?.hash as string;
  const height = `${MEMPOOL}/block-height/358391`;
  const fetch = network({
    [rawUrl]: held(rawUrl, () => new Response(raw)),
    [height]: held(height, () => new Response(hash)),
  });
  const started = performance.now();
  await verifyBundle(realBundle, opts({ fetch }));
  expect(performance.now() - started).toBeLessThan(1_500);
});

const CAPTURE = realBundle.capture_id;
const BUNDLE_URL = `https://reranker.co/api/evidence/bundles/${CAPTURE}`;

test("verifyCapture maps 404 to not_found and 404 with Retry-After to pending", async () => {
  const missing = await verifyCapture(CAPTURE, opts({ fetch: network() }));
  expect(missing.verdict).toBe("not_found");

  const unlogged = new Response("{}", { status: 404, headers: { "retry-after": "60" } });
  const pending = await verifyCapture(
    CAPTURE,
    opts({ fetch: network({ [BUNDLE_URL]: unlogged }) }),
  );
  expect(pending).toMatchObject({ verdict: "incomplete", retryAfter: 60 });
  expect(pending.checks.log).toEqual({ status: "pending", detail: "not_logged" });
});

test("verifyCapture verifies the bundle served at the fixed origin", async () => {
  const served = new Response(JSON.stringify(realBundle));
  const fetch = network({ [BUNDLE_URL]: served });
  expect((await verifyCapture(CAPTURE, opts({ fetch }))).verdict).toBe("intact_dating");
  expect(fetch.calls[0]).toBe(BUNDLE_URL);
});

test("verifyCapture never asks for an id that is not a capture id", async () => {
  const fetch = network();
  expect((await verifyCapture("../../admin", opts({ fetch }))).verdict).toBe("not_found");
  expect(fetch.calls).toEqual([]);
});

test("verifyCapture reports an unreachable or oversized bundle as incomplete", async () => {
  const down = network({ [BUNDLE_URL]: new TypeError("Failed to fetch") });
  expect((await verifyCapture(CAPTURE, opts({ fetch: down }))).verdict).toBe("incomplete");
  const huge = new Response("x".repeat(256 * 1024 + 1));
  const report = await verifyCapture(CAPTURE, opts({ fetch: network({ [BUNDLE_URL]: huge }) }));
  expect(report.checks.signature).toEqual({ status: "unavailable", detail: "bundle_too_large" });
});

test("key consistency runs for the capture key unless skipped", async () => {
  const fetch = network();
  const report = await verifyBundle(realBundle, opts({ fetch, skipKeyConsistency: false }));
  // Test keys are not in the production registry the three public places are compared with.
  expect(report.checks.keys).toEqual({ status: "fail", detail: "unknown_key", matches: 0, of: 3 });
  expect((await verifyBundle(realBundle, opts())).checks.keys).toEqual({
    status: "unavailable",
    detail: "skipped",
    matches: 0,
    of: 3,
  });
});

test("an envelope whose bytes JCS cannot pin has no log leaf, so it is a mismatch", async () => {
  const bundle = edit((b) => {
    b.envelope.signatures.push({
      keyid: "clé-inconnue",
      sig: b.envelope.signatures[0]?.sig as string,
    });
  });
  const report = await verifyBundle(bundle, opts());
  expect(report.checks.signature).toEqual({ status: "pass" });
  expect(report.checks.log).toEqual({ status: "fail", detail: "not_included" });
  expect(report.verdict).toBe("mismatch");
});

test("verifyCapture reports a failing bundle route as incomplete", async () => {
  const fetch = network({ [BUNDLE_URL]: new Response("busy", { status: 503 }) });
  const report = await verifyCapture(CAPTURE, opts({ fetch }));
  expect(report.verdict).toBe("incomplete");
  expect(report.checks.signature).toEqual({ status: "unavailable", detail: "http_503" });
});
