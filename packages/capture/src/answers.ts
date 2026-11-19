import { jcs } from "@reranker/catalog";
import { withSystem } from "@reranker/db";
import { captures } from "@reranker/db/schema";
import { getArtifact, latestNormalized, readRaw, sealReparse } from "@reranker/evidence";
import { InvalidInputError, NotFoundError } from "@reranker/jobs/errors";
import { type CaptureChannel, type EngineId, z } from "@reranker/schema";
import { CAPTURE_ID_PATTERN, type CaptureId } from "@reranker/verify/format";
import { eq, sql } from "drizzle-orm";
import { adapterFor, type CaptureRecord, registerCaptureAdapter } from "./adapters";
import { EngineAnswer, safeParseAnswer } from "./answer";
import { dataforseoAdapter } from "./dataforseo/adapter";
import { versionOf } from "./persist";
import { resolveRedirects } from "./resolve-redirects";
import { type SlotId, slotId } from "./slot";

registerCaptureAdapter(dataforseoAdapter);

/** What a reader of a measurement needs of each capture beside its answer. */
export type CaptureRowSummary = {
  id: CaptureId;
  engine: EngineId;
  channel: CaptureChannel;
  status: CaptureRecord["status"];
  modelReported: string | null;
  slotId: SlotId;
};

// Each read is an R2 GET; this many at once keeps a 200-capture report to a few round trips.
const READ_CONCURRENCY = 20;

function captureIdOf(captureId: string): CaptureId {
  if (!CAPTURE_ID_PATTERN.test(captureId)) {
    throw new InvalidInputError(`Invalid capture id ${JSON.stringify(captureId)}`);
  }
  return captureId as CaptureId;
}

async function readAnswer(sha256: string): Promise<EngineAnswer> {
  // getArtifact returns null for bytes that do not hash to the digest.
  const bytes = await getArtifact("normalized", sha256);
  if (bytes === null) throw new NotFoundError(`Normalized answer ${sha256} is missing or altered`);
  return EngineAnswer.parse(JSON.parse(new TextDecoder().decode(bytes)));
}

async function mapLimit<T, R>(items: readonly T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < items.length; i = next++) out[i] = await fn(items[i] as T);
  };
  await Promise.all(Array.from({ length: Math.min(READ_CONCURRENCY, items.length) }, worker));
  return out;
}

/** The newest reading of a capture: its highest-version reparse, else its original parse. */
export async function getAnswer(captureId: string): Promise<EngineAnswer> {
  const id = captureIdOf(captureId);
  const latest = await latestNormalized(id);
  if (latest === null) throw new NotFoundError(`Capture ${id} has no parsed answer`);
  return readAnswer(latest.sha256);
}

type ListedRow = {
  id: CaptureId;
  slot_index: number;
  engine: EngineId;
  channel: CaptureChannel;
  status: CaptureRecord["status"];
  model_reported: string | null;
  normalized_sha256: Buffer | null;
};

/**
 * Every succeeded capture of a measurement with its newest reading, in slot order. A capture whose
 * response did not parse lists with a null answer.
 */
export async function listAnswers(measurementId: string): Promise<
  Array<{
    captureId: CaptureId;
    slotId: SlotId;
    capture: CaptureRowSummary;
    answer: EngineAnswer | null;
  }>
> {
  if (!z.uuid().safeParse(measurementId).success) {
    throw new InvalidInputError(`Invalid measurement id ${JSON.stringify(measurementId)}`);
  }
  // The same choice as latestNormalized, for all captures at once: served by captures_one_success
  // and the primary key of evidence_entries.
  const { rows } = await withSystem(
    "capture.answers",
    (tx) =>
      tx.execute<ListedRow>(sql`
        select c.id, c.slot_index, c.engine, c.channel, c.status, c.model_reported,
               coalesce(r.normalized_sha256, c.normalized_sha256) as normalized_sha256
        from public_panel.captures c
        left join lateral (
          select e.normalized_sha256
          from public_panel.evidence_entries e
          where e.ref = c.id and e.kind = 'reparse'
          order by e.revision desc
          limit 1
        ) r on true
        where c.measurement_id = ${measurementId} and c.status = 'succeeded'
        order by c.slot_index`),
    { readOnly: true },
  );
  return mapLimit(rows, async (row) => {
    const id = slotId(measurementId, row.slot_index);
    return {
      captureId: row.id,
      slotId: id,
      capture: {
        id: row.id,
        engine: row.engine,
        channel: row.channel,
        status: row.status,
        modelReported: row.model_reported,
        slotId: id,
      },
      answer:
        row.normalized_sha256 === null
          ? null
          : await readAnswer(row.normalized_sha256.toString("hex")),
    };
  });
}

/**
 * Keeps where each redirect was found to lead: a re-derivation reads the same bytes, so it must not
 * depend on Google answering again. Only redirects never resolved are tried once more.
 */
async function withKnownRedirects(
  answer: EngineAnswer,
  previous: EngineAnswer | null,
): Promise<EngineAnswer> {
  const known = new Map<string, string>();
  for (const source of previous?.sources ?? []) {
    if (source.resolvedUrl !== undefined) known.set(source.url, source.resolvedUrl);
  }
  const carried = answer.sources.map((source) => {
    const resolvedUrl = known.get(source.url);
    return resolvedUrl === undefined ? source : { ...source, resolvedUrl };
  });
  const unknown = carried.filter((source) => source.resolvedUrl === undefined);
  const fresh = await resolveRedirects({ ...answer, sources: unknown });
  for (const source of fresh.sources) {
    if (source.resolvedUrl !== undefined) known.set(source.url, source.resolvedUrl);
  }
  return {
    ...answer,
    sources: carried.map((source) => {
      const resolvedUrl = known.get(source.url);
      return resolvedUrl === undefined ? source : { ...source, resolvedUrl };
    }),
  };
}

/**
 * Re-derives a capture's answer from its sealed raw bytes with the current parser and seals the
 * result as a new reading. The raw bytes, the row and every earlier reading stay as they are.
 * A parser no newer than the newest reading stores nothing and returns that reading.
 */
export async function reparse(captureId: string): Promise<EngineAnswer> {
  const id = captureIdOf(captureId);
  const [row] = await withSystem(
    "capture.answers",
    (tx) =>
      tx
        .select({ engine: captures.engine, provider: captures.provider, status: captures.status })
        .from(captures)
        .where(eq(captures.id, id)),
    { readOnly: true },
  );
  if (!row) throw new NotFoundError(`Capture ${id} does not exist`);
  if (row.status !== "succeeded") {
    throw new InvalidInputError(`Capture ${id} is a ${row.status}; it holds no answer to parse`);
  }
  const { parse } = adapterFor(row.provider);
  if (!parse) throw new InvalidInputError(`${row.provider} answers cannot be re-derived`);

  const [raw, latest] = await Promise.all([readRaw(id), latestNormalized(id)]);
  const previous = latest === null ? null : await readAnswer(latest.sha256);
  const parsed = safeParseAnswer((bytes) => parse(row.engine, bytes), raw);
  if (parsed.answer === null) {
    throw new InvalidInputError(`Capture ${id} does not parse: ${parsed.error}`);
  }
  const parserVersion = versionOf(parsed.answer);
  if (latest !== null && previous !== null && parserVersion <= latest.parserVersion) {
    return previous;
  }
  const answer = await withKnownRedirects(parsed.answer, previous);
  await withSystem("capture", (tx) =>
    sealReparse({ captureId: id, normalized: { json: jcs(answer), parserVersion } }, { tx }),
  );
  return answer;
}
