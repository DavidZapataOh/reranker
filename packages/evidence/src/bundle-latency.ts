import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { type SystemTx, withSystem } from "@reranker/db";
import { type LatencyStats, summarize } from "@reranker/jobs";
import { InvalidInputError } from "@reranker/jobs/errors";
import { log } from "@reranker/telemetry";
import type { CaptureId } from "@reranker/verify/format";
import { type SQL, sql } from "drizzle-orm";
import { ulid } from "ulid";
import {
  deleteArtifact,
  deleteLogObject,
  PROBE_LOG_PREFIX,
  putArtifact,
  putLogObject,
} from "./artifacts";
import { assembleBundle, bundleQuery, type Reader, removalsQuery, summarizeSeals } from "./bundle";
import { signEnvelope } from "./dsse";
import { EvidenceStorageUnavailableError } from "./errors";
import { PROBE_PREDICATE } from "./latency";
import { formatCheckpoint, signCheckpoint } from "./log/checkpoint";
import { readHashes } from "./log/tiles";
import {
  type Hash,
  newTiles,
  proveRecord,
  proveTree,
  storedHashes,
  storedHashIndex,
  TILE_HEIGHT,
  tilePath,
  treeHash,
} from "./log/tlog";
import { logOrigin, readStatement, subjectDigest } from "./seal";
import type { Signer } from "./signer";
import { buildCaptureStatement } from "./statement";

export interface BundleLatency {
  /** A whole bundle, its reads inside the probe's transaction. */
  buildBundle: LatencyStats;
  /** One empty read-only transaction: a real bundle opens two around its reads. */
  transaction: LatencyStats;
  /** The query for the capture, its batches and their anchors. */
  database: LatencyStats;
  /** The removal lookup of the capture's artifacts. */
  removals: LatencyStats;
  /** The envelope from R2, checked against its digest. */
  envelopeRead: LatencyStats;
  /** Inclusion and consistency proofs from the tiles, their own level-0 tile cold. */
  proofs: LatencyStats;
  /** getSealSummaries over every capture the probe seeded, as a report asks for them. */
  sealSummaries: LatencyStats;
}

export const MAX_BUNDLE_PROBES = 200;
export const DEFAULT_BUNDLE_PROBES = 100;

const TILE_WIDTH = 2 ** TILE_HEIGHT;
// Three tile levels, as the log has past 65,536 entries; the last level-0 tile is partial.
const MIN_TREE_SIZE = TILE_WIDTH ** 2 + 100;
// What the latest checkpoint adds past the anchored one: a few minutes of captures.
const LATEST_GROWTH = 300;
const WRITE_CONCURRENCY = 32;
// The sizes the anchors have: a calendar-upgraded .ots and a DigiCert token.
const OTS_PROOF_BYTES = 2048;
const TSR_BYTES = 5 * 1024;
const OCTETS = "application/octet-stream";
const ENVELOPE_CONTENT_TYPE = "application/vnd.dsse.envelope.v1+json";

const randomHex = () => randomBytes(32).toString("hex");

// The probe's statements and checkpoints are signed with a key that lives for one call: they
// name no real capture and are never part of the real log.
function probeSigner(): Signer {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ format: "der", type: "spki" });
  return {
    keyid: "latency-probe",
    publicKey: new Uint8Array(spki.subarray(spki.length - 32)),
    sign: async (message) => new Uint8Array(sign(null, message, privateKey)),
  };
}

// Thrown with the report so the seeding transaction rolls back.
class ProbeDone extends Error {
  readonly report: BundleLatency;
  constructor(report: BundleLatency) {
    super("latency probe finished");
    this.report = report;
  }
}

type Seed = {
  origin: string;
  captures: Array<{ id: CaptureId; index: number; envelopeSha256: string }>;
  anchored: number;
  latest: number;
  notes: { anchored: string; latest: string };
  tiles: Map<string, Uint8Array<ArrayBuffer>>;
  envelopes: Map<string, Uint8Array>;
};

async function inBatches<T>(items: T[], fn: (item: T) => Promise<unknown>): Promise<void> {
  for (let i = 0; i < items.length; i += WRITE_CONCURRENCY) {
    const settled = await Promise.allSettled(items.slice(i, i + WRITE_CONCURRENCY).map(fn));
    const failed = settled.find((r): r is PromiseRejectedResult => r.status === "rejected");
    if (failed) throw failed.reason;
  }
}

/**
 * A log of its own origin with `count` captures, each alone in its level-0 tile, at indexes past
 * every one the real log holds, so the rows never collide with it.
 */
async function buildSeed(count: number, firstFreeIndex: number, signer: Signer): Promise<Seed> {
  const host = logOrigin().split("/")[0];
  const origin = `${host}/${PROBE_LOG_PREFIX}${ulid()}`;
  const base = Math.ceil(firstFreeIndex / TILE_WIDTH) * TILE_WIDTH;
  const anchored = Math.max(base + count * TILE_WIDTH + 100, MIN_TREE_SIZE);
  const latest = anchored + LATEST_GROWTH;

  const captures: Seed["captures"] = [];
  const envelopes = new Map<string, Uint8Array>();
  const leaves = new Map<number, Uint8Array>();
  for (let j = 0; j < count; j++) {
    const id: CaptureId = `cap_${ulid()}`;
    const statement = buildCaptureStatement({
      captureId: id,
      rawSha256: randomHex(),
      requestSha256: randomHex(),
      normalizedSha256: randomHex(),
      predicate: PROBE_PREDICATE,
      signedAt: new Date(),
    });
    const signed = await signEnvelope(new TextEncoder().encode(JSON.stringify(statement)), [
      signer,
    ]);
    const index = base + j * TILE_WIDTH + ((j * 97) % TILE_WIDTH);
    captures.push({ id, index, envelopeSha256: signed.sha256 });
    envelopes.set(signed.sha256, signed.bytes);
    leaves.set(index, new Uint8Array(Buffer.from(signed.sha256, "hex")));
  }

  // Every other entry is a random digest: only the probe's own leaves are ever proven.
  const filler = randomBytes(latest * 32);
  const store: Hash[] = [];
  const read = async (indexes: number[]) => indexes.map((index) => store[index] as Hash);
  for (let n = 0; n < latest; n++) {
    const entry = leaves.get(n) ?? filler.subarray(n * 32, (n + 1) * 32);
    store.push(...(await storedHashes(n, entry, read)));
  }
  const note = async (size: number) =>
    signCheckpoint(
      formatCheckpoint({ origin, size, root: await treeHash(size, read) }),
      signer,
      origin,
    );

  const prefix = `${origin.slice(origin.indexOf("/") + 1)}/`;
  const tiles = new Map<string, Uint8Array<ArrayBuffer>>();
  for (const tile of [...newTiles(0, anchored), ...newTiles(0, latest)]) {
    const start = tile.n * TILE_WIDTH;
    const hashes = Array.from(
      { length: tile.width },
      (_, i) => store[storedHashIndex(tile.level * TILE_HEIGHT, start + i)] as Hash,
    );
    tiles.set(prefix + tilePath(tile), Buffer.concat(hashes));
  }
  return {
    origin,
    captures,
    anchored,
    latest,
    notes: { anchored: await note(anchored), latest: await note(latest) },
    tiles,
    envelopes,
  };
}

async function firstFreeIndex(tx: SystemTx): Promise<number> {
  const { rows } = await tx.execute<{ next: string }>(sql`
    select greatest(
      (select coalesce(max(log_index) + 1, 0) from public_panel.captures),
      (select coalesce(max(log_index) + 1, 0) from public_panel.evidence_entries)) as next`);
  return Number(rows[0]?.next ?? 0);
}

async function insertSeed(tx: SystemTx, seed: Seed): Promise<void> {
  const {
    rows: [plan],
  } = await tx.execute<{ id: string }>(sql`
    insert into public_panel.measurement_plans (purpose, ref_type, ref_id, digest, slot_count)
    values ('contract-test', 'probe', gen_random_uuid(), ${randomBytes(32)},
      ${seed.captures.length})
    returning id`);
  if (!plan) throw new Error("The probe's measurement plan was not inserted");
  await tx.execute(sql`
    insert into public_panel.captures (id, measurement_id, slot_index, attempt, intent_set_id,
      intent_id, engine, channel, provider, mode, status, response_bytes, latency_ms,
      cost_amount_micros, cost_currency, envelope_sha256, normalized_sha256, parser_version,
      log_index)
    select v.id, ${plan.id}, v.slot - 1, 1, 'is_latencyprobe', 'latency-probe', 'chatgpt',
      'ui-vendor', 'dataforseo', 'live', 'succeeded', 24576, 900, 0, 'USD',
      decode(v.envelope, 'hex'), sha256(convert_to(v.id, 'UTF8')), 1, v.log_index
    from unnest(${sql.param(seed.captures.map((c) => c.id))}::text[],
                ${sql.param(seed.captures.map((c) => c.envelopeSha256))}::text[],
                ${sql.param(seed.captures.map((c) => c.index))}::bigint[])
      with ordinality as v(id, envelope, log_index, slot)`);
  await tx.execute(sql`
    insert into public_panel.evidence_batches (origin, tree_size, first_index, root, frontier,
      checkpoint_note, published_at)
    values
      (${seed.origin}, ${seed.anchored}, ${seed.anchored - 1}, ${randomBytes(32)},
        ${randomBytes(32)}, ${seed.notes.anchored}, now()),
      (${seed.origin}, ${seed.latest}, ${seed.anchored}, ${randomBytes(32)}, ${randomBytes(32)},
        ${seed.notes.latest}, now())`);
  await tx.execute(sql`
    insert into public_panel.timestamp_anchors
      (origin, tree_size, kind, provider, status, proof, bitcoin_height, attested_at)
    values
      (${seed.origin}, ${seed.anchored}, 'ots', 'ots-calendars', 'confirmed',
        ${randomBytes(OTS_PROOF_BYTES)}, 900000, now()),
      (${seed.origin}, ${seed.anchored}, 'rfc3161', 'digicert', 'confirmed',
        ${randomBytes(TSR_BYTES)}, null, null)`);
}

async function timed<T>(samples: number[] | null, fn: () => Promise<T>): Promise<T> {
  const startedAt = performance.now();
  const result = await fn();
  samples?.push(performance.now() - startedAt);
  return result;
}

// Every object is attempted even when one fails; each one left behind is logged by its key, and
// the probe fails instead of reporting numbers over a leak.
async function removeAll(seed: Seed | undefined, written: Set<string>): Promise<void> {
  if (!seed) return;
  const removals = [...written].map((key) =>
    seed.envelopes.has(key) ? deleteArtifact("envelopes", key) : deleteLogObject(key),
  );
  const settled = await Promise.allSettled(removals);
  const leaked = [...written].filter((_, i) => settled[i]?.status === "rejected");
  for (const key of leaked) log.error("evidence.bundle_probe.leak", { key });
  if (leaked.length > 0) {
    throw new EvidenceStorageUnavailableError(`${leaked.length} probe objects were not deleted`);
  }
}

async function measure(tx: SystemTx, seed: Seed, n: number): Promise<BundleLatency> {
  const read: Reader = async <T extends Record<string, unknown>>(query: SQL) =>
    (await tx.execute<T>(query)).rows as T[];
  const ids = seed.captures.map((c) => c.id);
  const samples = {
    build: [] as number[],
    transaction: [] as number[],
    database: [] as number[],
    removals: [] as number[],
    envelope: [] as number[],
    proofs: [] as number[],
    summaries: [] as number[],
  };
  // The first pass opens every connection and loads the upper tiles, as a warm function has them.
  for (let i = 0; i <= n; i++) {
    const pick = (series: number[]) => (i > 0 ? series : null);
    const whole = seed.captures[2 * i];
    const parts = seed.captures[2 * i + 1];
    if (!whole || !parts) throw new Error("The probe seeded too few captures");

    const bundle = await timed(pick(samples.build), () =>
      assembleBundle(whole.id, seed.origin, read),
    );
    if (bundle?.inclusion.index !== whole.index || bundle.inclusion.tree_size !== seed.anchored) {
      throw new Error(`The probe's bundle of ${whole.id} is not the one it seeded`);
    }
    await timed(pick(samples.transaction), () =>
      withSystem("evidence.latency_probe", (t) => t.execute(sql`select 1`), { readOnly: true }),
    );
    await timed(pick(samples.database), () => read(bundleQuery(parts.id, seed.origin)));
    const { statement } = await timed(pick(samples.envelope), () =>
      readStatement(parts.envelopeSha256),
    );
    await timed(pick(samples.removals), () =>
      read(removalsQuery([subjectDigest(statement, "raw"), randomHex()])),
    );
    await timed(pick(samples.proofs), () =>
      Promise.all([
        proveRecord(seed.anchored, parts.index, readHashes(seed.origin, seed.anchored)),
        proveTree(seed.latest, seed.anchored, readHashes(seed.origin, seed.latest)),
      ]),
    );
    await timed(pick(samples.summaries), () => summarizeSeals(ids, seed.origin, read));
  }
  return {
    buildBundle: summarize(samples.build),
    transaction: summarize(samples.transaction),
    database: summarize(samples.database),
    removals: summarize(samples.removals),
    envelopeRead: summarize(samples.envelope),
    proofs: summarize(samples.proofs),
    sealSummaries: summarize(samples.summaries),
  };
}

/**
 * Times `n` bundles, and each of their parts on its own, against this deployment's database and
 * R2 buckets. It publishes a throwaway log of its own origin: the envelopes and tiles it writes
 * are deleted before it returns, and its rows live only in a transaction it rolls back, since
 * the real log's tables are append-only.
 */
export async function probeBuildBundle(n: number = DEFAULT_BUNDLE_PROBES): Promise<BundleLatency> {
  if (!Number.isInteger(n) || n < 1 || n > MAX_BUNDLE_PROBES) {
    throw new InvalidInputError(`A bundle probe builds 1 to ${MAX_BUNDLE_PROBES} bundles`);
  }
  const signer = probeSigner();
  let seed: Seed | undefined;
  const written = new Set<string>();
  let report: BundleLatency | undefined;
  let failure: unknown;
  try {
    await withSystem(
      "evidence.latency_probe",
      async (tx) => {
        seed = await buildSeed(2 * (n + 1), await firstFreeIndex(tx), signer);
        const current = seed;
        await inBatches([...current.envelopes], async ([sha256, bytes]) => {
          await putArtifact("envelopes", bytes, { contentType: ENVELOPE_CONTENT_TYPE });
          written.add(sha256);
        });
        await inBatches([...current.tiles], async ([key, bytes]) => {
          await putLogObject(key, bytes, { immutable: true, contentType: OCTETS });
          written.add(key);
        });
        await insertSeed(tx, current);
        throw new ProbeDone(await measure(tx, current, n));
      },
      { statementTimeoutMs: 30_000 },
    );
  } catch (error) {
    if (error instanceof ProbeDone) report = error.report;
    else failure = error;
  }
  const removal = removeAll(seed, written);
  if (failure !== undefined || !report) {
    // The leak is already logged; the error that interrupted the probe is the one to answer.
    await removal.catch(() => undefined);
    throw failure;
  }
  await removal;
  return report;
}
