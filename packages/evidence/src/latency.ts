import { createHash, randomBytes } from "node:crypto";
import { withSystem } from "@reranker/db";
import { COUNTRIES, DEFAULT_COUNTRY_CODE } from "@reranker/i18n/countries";
import { type LatencyStats, summarize } from "@reranker/jobs";
import { InvalidInputError } from "@reranker/jobs/errors";
import { log } from "@reranker/telemetry";
import { type CaptureId, DSSE_PAYLOAD_TYPE, MAX_PAE_BYTES, pae } from "@reranker/verify/format";
import { ulid } from "ulid";
import { type ArtifactKind, deleteArtifact, putArtifact } from "./artifacts";
import { EvidenceStorageUnavailableError, StatementTooLargeError } from "./errors";
import { scheduleIntegration } from "./jobs";
import { captureRow, logOrigin, type SealCaptureInput, sealCapture } from "./seal";
import { loadSigner, signingProvisioned } from "./signer";
import { buildCaptureStatement, type CapturePredicateInput } from "./statement";

export interface SealLatency {
  /** The whole seal; null while this environment has no capture key, since signing fails closed. */
  sealCapture: LatencyStats | null;
  /** The four objects a seal writes, written at once as a seal writes them. */
  r2WriteRound: LatencyStats;
  /** The retry check in the caller's transaction and the integration it schedules. */
  database: LatencyStats;
  /** Digests, statement and the DSSE message KMS would sign. */
  envelope: LatencyStats;
  /** One KMS Sign; null like sealCapture. */
  sign: LatencyStats | null;
}

export const MAX_SEAL_PROBES = 200;
export const DEFAULT_SEAL_PROBES = 100;
// A DataForSEO answer with sources runs to tens of kilobytes.
const RESPONSE_BYTES = 24 * 1024;
const JSON_CONTENT_TYPE = "application/json";

const sha256Hex = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const utf8 = (s: string) => new TextEncoder().encode(s);

// The predicate of a ChatGPT capture through DataForSEO, the path almost every seal takes. It is
// signed but never logged: no capture row or log entry ever names it.
const country = COUNTRIES[DEFAULT_COUNTRY_CODE];

const PROBE_PREDICATE: CapturePredicateInput = {
  plan: null,
  prompt: {
    set_version: "latency-probe",
    set_root: "0".repeat(64),
    intent_id: "latency-probe",
    paraphrase_id: "p1",
    persona_id: null,
    lang: country.defaultLocale,
    text: "latency probe",
  },
  engine: {
    name: "chatgpt",
    surface: "chatgpt-web",
    channel: "ui-vendor",
    vendor: "dataforseo",
    vendor_task_id: null,
    endpoint: "/v3/ai_optimization/chat_gpt/llm_scraper/live/advanced",
    model_reported: null,
    mode: "live",
    tool_version: null,
    fan_out_queries: null,
  },
  params: { force_web_search: true, temperature: null },
  geo: {
    declared: {
      country: country.code,
      region: null,
      city: null,
      vendor_location_code: country.providers.dataforseo.locationCode,
    },
    egress: null,
  },
  session: { state: "anonymous", fresh: true },
  provider_signature: null,
  tlsn: null,
  c2pa: null,
};

// Fresh bytes on every call, so no write is answered by its precondition and every object the
// probe deletes is one only it wrote.
function probeCapture(): SealCaptureInput {
  const captureId: CaptureId = `cap_${ulid()}`;
  const markdown = randomBytes(Math.ceil((RESPONSE_BYTES * 3) / 4)).toString("base64");
  return {
    captureId,
    responseBytes: utf8(`{"tasks":[{"id":"${captureId}","result":[{"markdown":"${markdown}"}]}]}`),
    responseContentType: JSON_CONTENT_TYPE,
    requestBytes: utf8(`[{"user_prompt":"latency probe","id":"${captureId}"}]`),
    normalized: { json: utf8(`{"answer":null,"id":"${captureId}"}`), parserVersion: 1 },
    predicate: PROBE_PREDICATE,
  };
}

type Written = Array<[ArtifactKind, string]>;

function inputArtifacts(input: SealCaptureInput): Written {
  const written: Written = [
    ["raw", sha256Hex(input.responseBytes)],
    ["request", sha256Hex(input.requestBytes)],
  ];
  if (input.normalized) written.push(["normalized", sha256Hex(input.normalized.json)]);
  return written;
}

async function timed<T>(samples: number[] | null, fn: () => Promise<T>): Promise<T> {
  const startedAt = performance.now();
  const result = await fn();
  samples?.push(performance.now() - startedAt);
  return result;
}

function envelopeMessage(input: SealCaptureInput): Uint8Array {
  const statement = buildCaptureStatement({
    captureId: input.captureId,
    rawSha256: sha256Hex(input.responseBytes),
    requestSha256: sha256Hex(input.requestBytes),
    normalizedSha256: input.normalized ? sha256Hex(input.normalized.json) : null,
    predicate: input.predicate,
    signedAt: new Date(),
  });
  const message = pae(DSSE_PAYLOAD_TYPE, utf8(JSON.stringify(statement)));
  if (message.length > MAX_PAE_BYTES)
    throw new StatementTooLargeError(message.length, MAX_PAE_BYTES);
  return message;
}

async function writeRound(samples: number[] | null, written: Written): Promise<void> {
  const objects: Array<[ArtifactKind, number]> = [
    ["raw", RESPONSE_BYTES],
    ["request", 512],
    ["normalized", 2048],
    ["envelopes", 2048],
  ];
  const startedAt = performance.now();
  const settled = await Promise.allSettled(
    objects.map(async ([kind, size]) => {
      const { sha256 } = await putArtifact(kind, randomBytes(size), {
        contentType: JSON_CONTENT_TYPE,
      });
      written.push([kind, sha256]);
    }),
  );
  samples?.push(performance.now() - startedAt);
  const failed = settled.find((r): r is PromiseRejectedResult => r.status === "rejected");
  if (failed) throw failed.reason;
}

// Every object is attempted even when one fails; each one left behind is logged by its key so it
// can be removed by hand, and the probe fails instead of reporting numbers over a leak.
async function removeAll(written: Written): Promise<void> {
  const settled = await Promise.allSettled(
    written.map(([kind, sha256]) => deleteArtifact(kind, sha256)),
  );
  const leaked = written.filter((_, i) => settled[i]?.status === "rejected");
  for (const [kind, sha256] of leaked) log.error("evidence.latency_probe.leak", { kind, sha256 });
  if (leaked.length > 0) {
    throw new EvidenceStorageUnavailableError(`${leaked.length} probe objects were not deleted`);
  }
}

/**
 * Times `n` capture seals against this deployment's real buckets, database and KMS key, one after
 * another, with each part of a seal timed on its own beside them. Nothing it writes outlives the
 * call: no capture row or log entry is inserted and every stored object is deleted. Until the
 * environment has a capture key, the seal and the KMS Sign are reported as null and the other
 * parts are still measured.
 */
export async function probeSealCapture(n: number = DEFAULT_SEAL_PROBES): Promise<SealLatency> {
  if (!Number.isInteger(n) || n < 1 || n > MAX_SEAL_PROBES) {
    throw new InvalidInputError(`A seal probe makes 1 to ${MAX_SEAL_PROBES} seals`);
  }
  const canSign = signingProvisioned("capture");
  const origin = logOrigin();
  const signer = canSign ? await loadSigner("capture") : null;
  const samples = {
    seal: [] as number[],
    round: [] as number[],
    database: [] as number[],
    envelope: [] as number[],
    sign: [] as number[],
  };

  // The first pass opens every connection and is not recorded, as a warm function has them open.
  for (let i = 0; i <= n; i++) {
    const record = i > 0;
    const pick = (series: number[]) => (record ? series : null);
    const written: Written = [];
    let failure: unknown;
    try {
      if (canSign) {
        const input = probeCapture();
        written.push(...inputArtifacts(input));
        const sealed = await withSystem("evidence.latency_probe", (tx) =>
          timed(pick(samples.seal), () => sealCapture(input, { tx })),
        );
        written.push(["envelopes", sealed.envelopeSha256]);
      }
      await writeRound(pick(samples.round), written);
      await withSystem("evidence.latency_probe", (tx) =>
        timed(pick(samples.database), async () => {
          await captureRow(tx, `cap_${ulid()}`);
          await scheduleIntegration(origin, new Date());
        }),
      );
      const input = probeCapture();
      const message = await timed(pick(samples.envelope), async () => envelopeMessage(input));
      if (signer) await timed(pick(samples.sign), () => signer.sign(message));
    } catch (error) {
      failure = error;
    }
    const removal = removeAll(written);
    if (failure !== undefined) {
      // The leak is already logged; the error that interrupted the pass is the one to answer.
      await removal.catch(() => undefined);
      throw failure;
    }
    await removal;
  }

  return {
    sealCapture: canSign ? summarize(samples.seal) : null,
    r2WriteRound: summarize(samples.round),
    database: summarize(samples.database),
    envelope: summarize(samples.envelope),
    sign: canSign ? summarize(samples.sign) : null,
  };
}
