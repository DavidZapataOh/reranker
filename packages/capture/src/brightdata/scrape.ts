import { setTimeout as wait } from "node:timers/promises";
import { BRIGHTDATA_API, type BrightDataClient, type BrightDataDataset } from "./client";

export type ScrapeOutcome =
  | {
      kind: "response";
      http: number;
      body: Uint8Array;
      contentType: string;
      snapshotId: string | null;
      polls: number;
    }
  // The deadline came first; the snapshot keeps running and is billed, so its id must survive.
  | { kind: "pending"; snapshotId: string; polls: number };

// The 202's retry-after was 10 s when Bright Data documented it, and its polling examples wait the same.
const DEFAULT_POLL_MS = 10_000;

const IN_PROGRESS = new Set(["starting", "running"]);

const bytesOf = async (response: Response) => new Uint8Array(await response.arrayBuffer());

const contentTypeOf = (response: Response) =>
  response.headers.get("content-type") ?? "application/octet-stream";

function retryAfterMs(response: Response): number {
  const seconds = Number(response.headers.get("retry-after"));
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : DEFAULT_POLL_MS;
}

function jsonField(bytes: Uint8Array, key: string): string | null {
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    const field =
      value !== null && typeof value === "object" ? (value as Record<string, unknown>)[key] : null;
    return typeof field === "string" && field !== "" ? field : null;
  } catch {
    return null;
  }
}

/**
 * One input through the synchronous scrape. A job past Bright Data's one-minute window answers
 * 202 with a snapshot id, which is polled until ready and downloaded while the deadline allows.
 * Every outcome but the pending one comes back as bytes for the caller to classify.
 */
export async function scrapeOne(
  client: BrightDataClient,
  dataset: BrightDataDataset,
  input: Record<string, unknown>,
  opts: { signal: AbortSignal; deadline: number; sleep?: (ms: number) => Promise<void> },
): Promise<ScrapeOutcome> {
  const { signal, deadline } = opts;
  const sleep = opts.sleep ?? ((ms: number) => wait(ms, undefined, { signal }));
  const query = new URLSearchParams({
    dataset_id: client.datasetId(dataset),
    format: "json",
    include_errors: "true",
  });
  const scraped = await client.fetch(`${BRIGHTDATA_API}/datasets/v3/scrape?${query}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ input: [input] }),
    signal,
  });
  const body = await bytesOf(scraped);
  const snapshotId = scraped.status === 202 ? jsonField(body, "snapshot_id") : null;
  if (snapshotId === null) {
    return {
      kind: "response",
      http: scraped.status,
      body,
      contentType: contentTypeOf(scraped),
      snapshotId: null,
      polls: 0,
    };
  }

  const interval = retryAfterMs(scraped);
  const id = encodeURIComponent(snapshotId);
  const progressUrl = `${BRIGHTDATA_API}/datasets/v3/progress/${id}`;
  const snapshotUrl = `${BRIGHTDATA_API}/datasets/v3/snapshot/${id}?format=json`;
  let polls = 0;
  // A ready snapshot downloads at once; only the calls that found it unfinished wait first.
  let waitFirst = true;
  let ready = false;
  for (;;) {
    if (waitFirst) {
      if (Date.now() + interval > deadline) return { kind: "pending", snapshotId, polls };
      await sleep(interval);
      signal.throwIfAborted();
      polls += 1;
    }
    const response = await client.monitor(ready ? snapshotUrl : progressUrl, { signal });
    const bytes = await bytesOf(response);
    if (!ready && response.status === 200) {
      const status = jsonField(bytes, "status");
      if (status !== null && IN_PROGRESS.has(status)) continue;
      if (status === "ready") {
        ready = true;
        waitFirst = false;
        continue;
      }
    }
    // A snapshot still building answers its download with 202, or 409 when not ready for it.
    if (ready && (response.status === 202 || response.status === 409)) {
      waitFirst = true;
      continue;
    }
    client.deliver(response, bytes);
    return {
      kind: "response",
      http: response.status,
      body: bytes,
      contentType: contentTypeOf(response),
      snapshotId,
      polls,
    };
  }
}
