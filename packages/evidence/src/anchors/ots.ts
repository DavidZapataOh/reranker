import {
  bitcoinAttestations,
  mergeOtsTimestamps,
  type OtsTimestamp,
  parseOtsTimestamp,
} from "@reranker/verify/format";
import { TimestampUnavailableError } from "../errors";

// The calendar protocol of python-opentimestamps' calendar.py: POST <url>/digest and
// GET <url>/timestamp/<hex>, both answering a bare timestamp of at most 10,000 bytes.

/** Run by three independent operators, so one outage or one dishonest calendar cannot stop a proof. */
export const OTS_CALENDARS = [
  "https://alice.btc.calendar.opentimestamps.org",
  "https://finney.calendar.eternitywall.com",
  "https://btc.calendar.catallaxy.com",
] as const;

const MIN_CALENDARS = 2;
const MAX_RESPONSE_BYTES = 10_000;
const TIMEOUT_MS = 10_000;
const HEADERS = { Accept: "application/vnd.opentimestamps.v1", "User-Agent": "reranker-evidence" };

// The reference client's DEFAULT_CALENDAR_WHITELIST: a pending attestation names the URL to ask,
// and anything else would let a calendar answer point the worker at an arbitrary host.
const TRUSTED_CALENDAR_HOST =
  /^.+\.calendar\.(opentimestamps\.org|eternitywall\.com|catallaxy\.com)$/;

type Options = { signal?: AbortSignal; fetch?: typeof fetch };

class CalendarAnswerError extends Error {
  override readonly name = "CalendarAnswerError";
}

async function readCapped(response: Response): Promise<Uint8Array> {
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new CalendarAnswerError(`Calendar answer over ${MAX_RESPONSE_BYTES} bytes`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(length);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

/** One calendar call; null when the calendar does not know the commitment yet (404). */
async function call(url: string, init: RequestInit, opts: Options): Promise<Uint8Array | null> {
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const response = await (opts.fetch ?? fetch)(url, {
    ...init,
    headers: HEADERS,
    // Calendars answer directly; following a redirect would reach a host nobody vetted.
    redirect: "error",
    signal: opts.signal ? AbortSignal.any([timeout, opts.signal]) : timeout,
  });
  if (response.status === 404) {
    await response.body?.cancel();
    return null;
  }
  if (response.status !== 200 || !response.body) {
    await response.body?.cancel();
    throw new CalendarAnswerError(`Calendar answered ${response.status}`);
  }
  return readCapped(response);
}

/**
 * Submits `digest` to every calendar at once and merges their proofs. At least two must answer,
 * so the proof never rests on a single operator.
 */
export async function submitDigest(
  digest: Uint8Array,
  opts: Options = {},
): Promise<{ timestamp: OtsTimestamp; calendars: string[] }> {
  const results = await Promise.allSettled(
    OTS_CALENDARS.map(async (calendar) => {
      const body = await call(`${calendar}/digest`, { method: "POST", body: digest }, opts);
      if (!body) throw new CalendarAnswerError("Calendar answered 404");
      return { calendar, proof: parseOtsTimestamp(body, digest) };
    }),
  );
  const timestamp: OtsTimestamp = { msg: digest.slice(), attestations: [], ops: [] };
  const calendars: string[] = [];
  const failures: unknown[] = [];
  for (const r of results) {
    if (r.status === "rejected") {
      failures.push(r.reason);
      continue;
    }
    mergeOtsTimestamps(timestamp, r.value.proof);
    calendars.push(r.value.calendar);
  }
  if (calendars.length < MIN_CALENDARS) {
    throw new TimestampUnavailableError(
      `Only ${calendars.length} of ${OTS_CALENDARS.length} OpenTimestamps calendars answered`,
      { cause: new AggregateError(failures) },
    );
  }
  return { timestamp, calendars };
}

function isTrustedCalendar(uri: string): boolean {
  if (!URL.canParse(uri)) return false;
  const url = new URL(uri);
  return (
    url.protocol === "https:" &&
    url.port === "" &&
    url.pathname === "/" &&
    TRUSTED_CALENDAR_HOST.test(url.hostname)
  );
}

/** The nodes the reference client asks about: the first ones on each path that carry attestations. */
function attestedNodes(t: OtsTimestamp): OtsTimestamp[] {
  return t.attestations.length > 0 ? [t] : t.ops.flatMap(({ next }) => attestedNodes(next));
}

/**
 * Asks each pending calendar for its commitment and merges what it answers into `t`, in place.
 * A calendar that is down, slow or not confirmed yet is skipped; the next run asks again.
 */
export async function upgradeTimestamp(
  t: OtsTimestamp,
  opts: Options = {},
): Promise<{ upgraded: boolean; bitcoin: { height: number } | null }> {
  const requests = attestedNodes(t).flatMap((node) =>
    node.attestations.flatMap((a) =>
      a.kind === "pending" && isTrustedCalendar(a.uri) ? [{ node, uri: a.uri }] : [],
    ),
  );
  const answers = await Promise.allSettled(
    requests.map(async ({ node, uri }) => {
      const body = await call(
        `${uri}/timestamp/${Buffer.from(node.msg).toString("hex")}`,
        { method: "GET" },
        opts,
      );
      return body && { node, proof: parseOtsTimestamp(body, node.msg) };
    }),
  );
  let upgraded = false;
  for (const a of answers) {
    if (a.status === "fulfilled" && a.value) {
      upgraded = mergeOtsTimestamps(a.value.node, a.value.proof) || upgraded;
    }
  }
  const heights = bitcoinAttestations(t).map((b) => b.height);
  return { upgraded, bitcoin: heights.length > 0 ? { height: Math.min(...heights) } : null };
}
