import { createPublicKey, randomBytes, randomUUID, verify } from "node:crypto";
import { endPools, withSystem } from "@reranker/db";
import { enqueue, type JobContext } from "@reranker/jobs";
import { merkleRoot } from "@reranker/verify/format";
import { noteKeyId } from "@reranker/verify/trust";
import { type SQL, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { integrateJob, publishJob } from "../src/jobs";
import { parseCheckpoint } from "../src/log/checkpoint";
import { integrate, MAX_BATCH_ENTRIES } from "../src/log/integrate";
import { loadSigner } from "../src/signer";
import { localSigner } from "./support/local-signer";

vi.mock("../src/signer", () => ({ loadSigner: vi.fn() }));
vi.mock("@reranker/jobs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@reranker/jobs")>()),
  enqueue: vi.fn(async () => ({ jobId: "evidence:test", created: true })),
}));
// Publication to R2 has its own suite; here the batches stay unpublished.
vi.mock("../src/log/tiles", () => ({
  publishPendingBatches: vi.fn(async () => ({ published: [] })),
}));

// Other suites share this database and leave entries pending, so every check is made on the whole
// log of this origin rather than on the rows a test inserted.
const ORIGIN = "log-preview.reranker.co/captures/2026";
const signer = localSigner("rr-log-preview-1");
const sign = vi.spyOn(signer, "sign");
const jobContext: JobContext = {
  attempt: 1,
  jobId: "evidence.integrate:test",
  signal: new AbortController().signal,
};

type Integrated = { status: "integrated"; treeSize: number; firstIndex: number };
type LogRow = { log_index: string; envelope_sha256: Buffer };
type Batch = { tree_size: string; first_index: string; root: Buffer; checkpoint_note: string };

const range = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => from + i);
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
const randomDigests = (n: number) => range(0, n).map(() => randomBytes(32).toString("hex"));
const query = <T extends Record<string, unknown>>(q: SQL) =>
  withSystem("evidence.test", async (tx) => (await tx.execute<T>(q)).rows);

/** n succeeded captures of one contract-test measurement, in one statement. */
async function seedCaptures(n: number): Promise<string[]> {
  const ids = range(0, n).map(() => `cap_${randomBytes(13).toString("hex").toUpperCase()}`);
  await query(sql`
    with plan as (
      insert into public_panel.measurement_plans (purpose, ref_type, ref_id, digest, slot_count)
      values ('contract-test', 'probe', ${randomUUID()}, ${randomBytes(32)}, ${n})
      returning id
    )
    insert into public_panel.captures (id, measurement_id, slot_index, attempt, intent_set_id,
      intent_id, engine, channel, provider, mode, status, response_bytes, latency_ms,
      cost_amount_micros, cost_currency, envelope_sha256)
    select v.id, plan.id, v.slot - 1, 1, 'is_0123456789abcdef', 'odontologia.blanqueamiento-dental',
      'chatgpt', 'ui-vendor', 'dataforseo', 'live', 'succeeded', 1024, 900, 4000, 'USD',
      decode(v.envelope, 'hex')
    from plan, unnest(${sql.param(ids)}::text[], ${sql.param(randomDigests(n))}::text[])
      with ordinality as v(id, envelope, slot)`);
  return ids;
}

/** n entries of `kind` waiting for the log, in one statement. */
async function seedEntries(n: number, kind = "consent"): Promise<string[]> {
  const refs = range(0, n).map(() => randomUUID());
  await query(sql`
    insert into public_panel.evidence_entries (ref, kind, envelope_sha256)
    select v.ref, ${kind}::public_panel.evidence_entry_kind, decode(v.envelope, 'hex')
    from unnest(${sql.param(refs)}::text[], ${sql.param(randomDigests(n))}::text[]) as v(ref, envelope)`);
  return refs;
}

async function latestBatch(): Promise<Batch | undefined> {
  const [batch] = await query<Batch>(sql`
    select tree_size, first_index, root, checkpoint_note from public_panel.evidence_batches
    where origin = ${ORIGIN} order by tree_size desc limit 1`);
  return batch;
}

/** Every entry of the log below `treeSize`, captures and other statements alike, in index order. */
const logRows = (treeSize: number) =>
  query<LogRow>(sql`
    select log_index, envelope_sha256 from public_panel.captures
    where log_index is not null and log_index < ${treeSize}
    union all
    select log_index, envelope_sha256 from public_panel.evidence_entries
    where log_index is not null and log_index < ${treeSize}
    order by log_index`);

async function indexesOf(ids: string[], refs: string[] = []): Promise<(number | null)[]> {
  const rows = await query<{ log_index: string | null }>(sql`
    select log_index from public_panel.captures where id = any(${sql.param(ids)}::text[])
    union all
    select log_index from public_panel.evidence_entries where ref = any(${sql.param(refs)}::text[])`);
  return rows.map((r) => (r.log_index === null ? null : Number(r.log_index)));
}

async function drain(): Promise<void> {
  for (let runs = 0; runs < 100; runs++) {
    if ((await integrate(ORIGIN)).status === "empty") return;
  }
  throw new Error("The log never drained");
}

/** The log of ORIGIN has indexes 0..size-1, each once, and its latest root covers them in order. */
async function expectConsistentLog(): Promise<{ treeSize: number; rows: LogRow[] }> {
  const batch = await latestBatch();
  if (!batch) throw new Error("No batch was integrated");
  const treeSize = Number(batch.tree_size);
  const rows = await logRows(treeSize);
  expect(rows.map((r) => Number(r.log_index))).toEqual(range(0, treeSize));
  expect(hex(batch.root)).toBe(hex(merkleRoot(rows.map((r) => r.envelope_sha256))));
  return { treeSize, rows };
}

/** Holds the log's lock in another transaction until the returned release is called. */
async function holdLogLock(): Promise<() => Promise<void>> {
  let release = () => {};
  let locked = () => {};
  const isLocked = new Promise<void>((resolve) => {
    locked = resolve;
  });
  const holder = withSystem("evidence.test", async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext('public_panel.evidence_batches'), hashtext(${ORIGIN}))`,
    );
    locked();
    await new Promise<void>((resolve) => {
      release = resolve;
    });
  });
  await Promise.race([isLocked, holder]);
  return async () => {
    release();
    await holder;
  };
}

beforeAll(() => {
  // Concurrency is real only with more connections than the default three of the system pool.
  process.env.DB_POOL_MAX = "12";
});
afterAll(() => endPools());

beforeEach(() => {
  vi.mocked(loadSigner).mockResolvedValue(signer);
  vi.mocked(enqueue).mockClear();
  sign.mockClear();
});

describe("integrate", () => {
  test("concurrent integrations append disjoint ranges without gaps under one final root", async () => {
    const ids = await seedCaptures(50);
    const results = await Promise.all([integrate(ORIGIN), integrate(ORIGIN), integrate(ORIGIN)]);
    const batches = results
      .filter((r): r is Integrated => r.status === "integrated")
      .sort((a, b) => a.firstIndex - b.firstIndex);
    expect(batches.length).toBeGreaterThanOrEqual(1);
    for (const [i, batch] of batches.entries()) {
      expect(batch.treeSize).toBeGreaterThan(batch.firstIndex);
      if (i > 0) expect(batch.firstIndex).toBe(batches[i - 1]?.treeSize);
    }
    await drain();
    const { treeSize } = await expectConsistentLog();
    const indexes = await indexesOf(ids);
    expect(new Set(indexes).size).toBe(50);
    expect(indexes.every((i) => i !== null && i < treeSize)).toBe(true);
  });

  test("an integration that finds the log locked is busy and assigns nothing", async () => {
    const ids = await seedCaptures(3);
    const release = await holdLogLock();
    try {
      // Only the call under the lock counts: earlier calls sign what other suites left pending.
      const before = await latestBatch();
      sign.mockClear();
      expect(await integrate(ORIGIN)).toEqual({ status: "busy" });
      expect(sign).not.toHaveBeenCalled();
      expect(await indexesOf(ids)).toEqual([null, null, null]);
      expect(await latestBatch()).toEqual(before);
    } finally {
      await release();
    }
  });

  test("pending entries are appended in envelope_sha256 order", async () => {
    await seedCaptures(20);
    await seedEntries(20);
    const result = await integrate(ORIGIN);
    expect(result.status).toBe("integrated");
    const { firstIndex, treeSize } = result as Integrated;
    const { rows } = await expectConsistentLog();
    const batch = rows.slice(firstIndex, treeSize).map((r) => r.envelope_sha256);
    expect(batch.length).toBeGreaterThanOrEqual(40);
    expect(batch).toEqual([...batch].sort(Buffer.compare));
  });

  test("captures and other statements share one index space", async () => {
    const ids = await seedCaptures(30);
    const plan = await seedEntries(1, "plan");
    const consent = await seedEntries(1, "consent");
    await drain();
    await expectConsistentLog();
    const indexes = await indexesOf(ids, [...plan, ...consent]);
    expect(indexes).toHaveLength(32);
    expect(indexes).not.toContain(null);
    expect(new Set(indexes).size).toBe(32);
  });

  test("a batch extends the previous frontier: two batches have the root of one", async () => {
    await seedEntries(7);
    await drain();
    await seedEntries(11);
    await drain();
    await expectConsistentLog();
  });

  test("nothing pending: no batch and no signature", async () => {
    let before: Batch | undefined;
    let signatures = 0;
    for (let runs = 0; ; runs++) {
      expect(runs).toBeLessThan(100);
      before = await latestBatch();
      signatures = sign.mock.calls.length;
      if ((await integrate(ORIGIN)).status === "empty") break;
    }
    expect(sign.mock.calls.length).toBe(signatures);
    expect(await latestBatch()).toEqual(before);
  });

  test("500 pending entries integrate in under 1.5 s", async () => {
    await drain();
    await seedCaptures(250);
    await seedEntries(250);
    const started = performance.now();
    const result = await integrate(ORIGIN);
    const elapsed = performance.now() - started;
    console.info(`integrate of 500 entries: ${elapsed.toFixed(0)} ms`);
    expect(result.status).toBe("integrated");
    const { firstIndex, treeSize } = result as Integrated;
    expect(treeSize - firstIndex).toBeGreaterThanOrEqual(500);
    expect(elapsed).toBeLessThan(1500);
  });

  test("the checkpoint note names the origin and size and verifies with the log key", async () => {
    await seedEntries(5);
    await drain();
    const batch = await latestBatch();
    const note = batch?.checkpoint_note ?? "";
    const checkpoint = parseCheckpoint(note);
    expect(checkpoint.origin).toBe(ORIGIN);
    expect(checkpoint.size).toBe(Number(batch?.tree_size));
    expect(hex(checkpoint.root)).toBe(hex(batch?.root ?? new Uint8Array()));
    const signatureLine = note.slice(checkpoint.body.length + 1, -1);
    const [, name, encoded] = signatureLine.split(" ");
    expect(name).toBe(ORIGIN);
    const signature = Buffer.from(encoded ?? "", "base64");
    expect(hex(signature.subarray(0, 4))).toBe(hex(noteKeyId(ORIGIN, signer.publicKey)));
    const publicKey = createPublicKey({
      key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), signer.publicKey]),
      format: "der",
      type: "spki",
    });
    expect(verify(null, Buffer.from(checkpoint.body), publicKey, signature.subarray(4))).toBe(true);
  });
});

describe("evidence.integrate job", () => {
  test("queues the publication of each new batch", async () => {
    await seedEntries(4);
    await integrateJob.handler({ origin: ORIGIN }, jobContext);
    const treeSize = Number((await latestBatch())?.tree_size);
    expect(enqueue).toHaveBeenCalledWith(
      publishJob,
      { origin: ORIGIN },
      { dedupeKey: `pub-${treeSize}` },
    );
  });

  test("a busy log is retried five seconds later", async () => {
    await seedEntries(1);
    const release = await holdLogLock();
    const started = Date.now();
    try {
      await integrateJob.handler({ origin: ORIGIN }, jobContext);
    } finally {
      await release();
    }
    const [job, payload, opts] = vi.mocked(enqueue).mock.calls[0] ?? [];
    expect(job).toBe(integrateJob);
    expect(payload).toEqual({ origin: ORIGIN });
    const runAt = opts?.runAt?.getTime() ?? 0;
    expect(runAt).toBeGreaterThanOrEqual(started + 5_000);
    expect(runAt).toBeLessThanOrEqual(Date.now() + 5_000);
    expect(opts?.dedupeKey).toMatch(/^int-busy-\d+$/);
    await drain();
  });

  test("a backlog over one batch continues in the next minute", async () => {
    await seedEntries(MAX_BATCH_ENTRIES + 1);
    await integrateJob.handler({ origin: ORIGIN }, jobContext);
    const batch = await latestBatch();
    expect(Number(batch?.tree_size) - Number(batch?.first_index)).toBe(MAX_BATCH_ENTRIES);
    const minute = Math.floor(Date.now() / 60_000);
    const continuation = vi.mocked(enqueue).mock.calls.find(([job]) => job === integrateJob);
    expect(continuation?.[2]?.dedupeKey).toMatch(new RegExp(`^int-(${minute - 1}|${minute})$`));
    await drain();
    await expectConsistentLog();
  }, 60_000);
});
