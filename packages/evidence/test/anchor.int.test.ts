import { randomBytes, randomUUID } from "node:crypto";
import { endPools, withSystem } from "@reranker/db";
import { type OtsTimestamp, parseDetachedOts, serializeDetachedOts } from "@reranker/verify/format";
import { type SQL, sql } from "drizzle-orm";
import { afterAll, beforeEach, expect, test, vi } from "vitest";
import { anchorLatest, upgradePendingOts } from "../src/anchors/anchor";
import { BlockHeaderUnavailableError, blockHeader } from "../src/anchors/bitcoin";
import { submitDigest, upgradeTimestamp } from "../src/anchors/ots";
import { requestTimestamp, TSAS } from "../src/anchors/rfc3161";
import { checkpointDigest, formatCheckpoint, signCheckpoint } from "../src/log/checkpoint";
import { localSigner } from "./support/local-signer";

vi.mock("../src/anchors/ots", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/anchors/ots")>()),
  submitDigest: vi.fn(),
  upgradeTimestamp: vi.fn(),
}));
vi.mock("../src/anchors/rfc3161", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/anchors/rfc3161")>()),
  requestTimestamp: vi.fn(),
}));
vi.mock("../src/anchors/bitcoin", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/anchors/bitcoin")>()),
  blockHeader: vi.fn(),
}));

const signer = localSigner("rr-log-preview-1");
const CALENDAR = "https://alice.btc.calendar.opentimestamps.org";
const DIGICERT = "http://timestamp.digicert.com";
const QTSA = "https://tsa.qtsa.eu/example";
const HOUR = 3_600_000;

type Anchor = {
  tree_size: string;
  kind: string;
  provider: string;
  status: string;
  proof: Buffer | null;
  attempts: number;
  next_attempt_ms: number;
  bitcoin_height: number | null;
  attested_ms: number | null;
};

const query = <T extends Record<string, unknown>>(q: SQL) =>
  withSystem("evidence.test", async (tx) => (await tx.execute<T>(q)).rows);
const pendingProof = (digest: Uint8Array): OtsTimestamp => ({
  msg: digest,
  attestations: [{ kind: "pending", uri: CALENDAR }],
  ops: [],
});
const tsr = (digest: Uint8Array) => new Uint8Array([0x30, 0x03, ...digest.subarray(0, 1), 0, 0]);

/** A log of its own origin, so assertions only ever see this test's rows. */
async function seedLog(
  sizes: number[],
  published = sizes,
): Promise<{ origin: string; notes: Map<number, string> }> {
  const origin = `log-test.reranker.co/anchor-${randomUUID()}`;
  const notes = new Map<number, string>();
  for (const size of sizes) {
    const root = new Uint8Array(randomBytes(32));
    notes.set(
      size,
      await signCheckpoint(formatCheckpoint({ origin, size, root }), signer, signer.keyid),
    );
  }
  await query(sql`
    insert into public_panel.evidence_batches
      (origin, tree_size, first_index, root, frontier, checkpoint_note, published_at)
    select ${origin}, v.size, v.size - 1, ${randomBytes(32)}, ${randomBytes(32)}, v.note,
      case when v.size = any(${sql.param(published)}::bigint[]) then now() end
    from unnest(${sql.param(sizes)}::bigint[], ${sql.param([...notes.values()])}::text[])
      as v(size, note)`);
  return { origin, notes };
}

const anchors = (origin: string) =>
  query<Anchor>(sql`
    select tree_size, kind, provider, status, proof, attempts, bitcoin_height,
      (extract(epoch from next_attempt_at) * 1000)::float8 as next_attempt_ms,
      (extract(epoch from attested_at) * 1000)::float8 as attested_ms
    from public_panel.timestamp_anchors where origin = ${origin} order by kind, provider`);

/** A pending OpenTimestamps anchor of a fresh log, as anchorLatest leaves it. */
async function seedPendingOts(opts: { attempts?: number; createdAgoMs?: number } = {}) {
  const { origin, notes } = await seedLog([1]);
  const digest = checkpointDigest(notes.get(1) as string);
  await query(sql`
    insert into public_panel.timestamp_anchors
      (origin, tree_size, kind, provider, status, proof, attempts, next_attempt_at, created_at)
    values (${origin}, 1, 'ots', 'ots-calendars', 'pending',
      ${Buffer.from(serializeDetachedOts(digest, pendingProof(digest)))}, ${opts.attempts ?? 0},
      '2000-01-01', now() - make_interval(secs => ${(opts.createdAgoMs ?? 0) / 1000}))`);
  return { origin, digest };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  // The production gate of qtsa.eu is covered by the unit tests; here it is a switch.
  vi.spyOn(TSAS.qtsa, "url").mockReturnValue(null);
  vi.mocked(submitDigest).mockImplementation(async (digest) => ({
    timestamp: pendingProof(digest),
    calendars: [CALENDAR],
  }));
  vi.mocked(requestTimestamp).mockImplementation(async (_url, digest) => tsr(digest));
  vi.mocked(upgradeTimestamp).mockResolvedValue({ upgraded: false, bitcoin: null });
});

afterAll(async () => {
  await endPools();
});

test("anchorLatest anchors the newest published checkpoint once and skips when nothing is new", async () => {
  const { origin, notes } = await seedLog([1, 2, 3, 4], [1, 2, 3]);

  expect(await anchorLatest(origin)).toEqual({
    treeSize: 3,
    ots: "pending",
    tsa: { qtsa: "skipped", digicert: "confirmed" },
  });
  const digest = checkpointDigest(notes.get(3) as string);
  expect(submitDigest).toHaveBeenCalledExactlyOnceWith(digest);
  expect(requestTimestamp).toHaveBeenCalledExactlyOnceWith(DIGICERT, digest);
  expect(await anchorLatest(origin)).toEqual({ treeSize: null });
  expect(submitDigest).toHaveBeenCalledOnce();

  const rows = await anchors(origin);
  expect(rows.map((r) => [Number(r.tree_size), r.kind, r.provider, r.status])).toEqual([
    [3, "ots", "ots-calendars", "pending"],
    [3, "rfc3161", "digicert", "confirmed"],
  ]);
  const ots = rows[0] as Anchor;
  expect(parseDetachedOts(new Uint8Array(ots.proof as Buffer)).digest).toEqual(digest);
  expect(rows[1]?.proof).toEqual(Buffer.from(tsr(digest)));
});

test("a log with no published checkpoint has nothing to anchor", async () => {
  const { origin } = await seedLog([1], []);
  expect(await anchorLatest(origin)).toEqual({ treeSize: null });
  expect(submitDigest).not.toHaveBeenCalled();
});

test("a qtsa.eu failure never blocks OpenTimestamps or DigiCert", async () => {
  vi.spyOn(TSAS.qtsa, "url").mockReturnValue(QTSA);
  vi.mocked(requestTimestamp).mockImplementation(async (url, digest) => {
    if (url === QTSA) throw new Error("TSA refused the request with PKIStatus 2");
    return tsr(digest);
  });
  const { origin } = await seedLog([5]);

  expect(await anchorLatest(origin)).toEqual({
    treeSize: 5,
    ots: "pending",
    tsa: { qtsa: "failed", digicert: "confirmed" },
  });
  expect((await anchors(origin)).map((r) => [r.provider, r.status, r.proof === null])).toEqual([
    ["ots-calendars", "pending", false],
    ["digicert", "confirmed", false],
    ["qtsa", "failed", true],
  ]);
});

test("a failed OpenTimestamps submission is retried next hour without stamping again", async () => {
  vi.spyOn(TSAS.qtsa, "url").mockReturnValue(QTSA);
  vi.mocked(submitDigest).mockRejectedValueOnce(new Error("Only 1 of 3 calendars answered"));
  const { origin } = await seedLog([2]);

  expect(await anchorLatest(origin)).toMatchObject({ treeSize: 2, ots: "failed" });
  expect((await anchors(origin)).map((r) => r.kind)).toEqual(["rfc3161", "rfc3161"]);

  expect(await anchorLatest(origin)).toEqual({
    treeSize: 2,
    ots: "pending",
    tsa: { qtsa: "skipped", digicert: "skipped" },
  });
  expect(requestTimestamp).toHaveBeenCalledTimes(2);
  expect((await anchors(origin)).map((r) => r.provider)).toEqual([
    "ots-calendars",
    "digicert",
    "qtsa",
  ]);
});

test("upgradePendingOts confirms with height and block time, backs off 15 min → 2 h, and flags pending over 24 h", async () => {
  const now = new Date();
  const confirmed = await seedPendingOts();
  const fresh = await seedPendingOts();
  const tired = await seedPendingOts({ attempts: 4 });
  const late = await seedPendingOts({ createdAgoMs: 25 * HOUR });
  const blockTime = new Date("2026-11-18T03:12:45Z");
  const commitment = Buffer.from(confirmed.digest).reverse().toString("hex");
  vi.mocked(upgradeTimestamp).mockImplementation(async (t) => {
    if (Buffer.from(t.msg).equals(Buffer.from(confirmed.digest))) {
      t.attestations.push({ kind: "bitcoin", height: 925_001 });
      return { upgraded: true, bitcoin: { height: 925_001 } };
    }
    return { upgraded: false, bitcoin: null };
  });
  vi.mocked(blockHeader).mockResolvedValue({
    hash: "00".repeat(32),
    merkleRoot: commitment,
    time: blockTime,
  });

  const result = await upgradePendingOts(now);
  expect(result.confirmed).toBeGreaterThanOrEqual(1);
  expect(result.checked).toBeGreaterThanOrEqual(4);
  expect(result.overdue).toBeGreaterThanOrEqual(1);
  expect(blockHeader).toHaveBeenCalledWith(925_001);

  const [done] = await anchors(confirmed.origin);
  expect(done).toMatchObject({ status: "confirmed", bitcoin_height: 925_001, attempts: 1 });
  expect(done?.attested_ms).toBe(blockTime.getTime());
  const upgraded = parseDetachedOts(new Uint8Array(done?.proof as Buffer)).timestamp;
  expect(upgraded.attestations).toContainEqual({ kind: "bitcoin", height: 925_001 });

  const [waiting] = await anchors(fresh.origin);
  expect(waiting).toMatchObject({ status: "pending", attempts: 1 });
  expect(waiting?.next_attempt_ms).toBe(now.getTime() + HOUR / 4);
  const [capped] = await anchors(tired.origin);
  expect(capped).toMatchObject({ status: "pending", attempts: 5 });
  expect(capped?.next_attempt_ms).toBe(now.getTime() + 2 * HOUR);
  expect((await anchors(late.origin))[0]?.status).toBe("pending");

  // Nothing is due again until its backoff passes.
  vi.mocked(upgradeTimestamp).mockClear();
  await upgradePendingOts(now);
  const asked = vi
    .mocked(upgradeTimestamp)
    .mock.calls.map(([t]) => Buffer.from(t.msg).toString("hex"));
  expect(asked).not.toContain(Buffer.from(fresh.digest).toString("hex"));
});

test("a Bitcoin attestation no explorer block carries fails the proof; an unreachable explorer retries", async () => {
  const forged = await seedPendingOts();
  const unsure = await seedPendingOts();
  vi.mocked(upgradeTimestamp).mockImplementation(async (t) => {
    const mine = [forged.digest, unsure.digest].some((d) =>
      Buffer.from(t.msg).equals(Buffer.from(d)),
    );
    if (!mine) return { upgraded: false, bitcoin: null };
    t.attestations.push({ kind: "bitcoin", height: 925_002 });
    return { upgraded: true, bitcoin: { height: 925_002 } };
  });
  vi.mocked(blockHeader).mockImplementation(async () => {
    throw new BlockHeaderUnavailableError("Explorers disagree on block 925002");
  });
  await upgradePendingOts();
  expect((await anchors(unsure.origin))[0]).toMatchObject({ status: "pending", attempts: 1 });

  vi.mocked(blockHeader).mockResolvedValue({
    hash: "00".repeat(32),
    merkleRoot: "ff".repeat(32),
    time: new Date(),
  });
  await upgradePendingOts(new Date(Date.now() + HOUR));
  expect((await anchors(forged.origin))[0]?.status).toBe("failed");
});

test("an unreadable proof backs off on its own and the others still upgrade", async () => {
  const broken = await seedPendingOts();
  const fine = await seedPendingOts();
  vi.mocked(upgradeTimestamp).mockImplementation(async (t) => {
    if (Buffer.from(t.msg).equals(Buffer.from(broken.digest))) throw new Error("calendar bug");
    return { upgraded: false, bitcoin: null };
  });
  await upgradePendingOts();
  expect((await anchors(broken.origin))[0]).toMatchObject({ status: "pending", attempts: 1 });
  expect((await anchors(fine.origin))[0]).toMatchObject({ status: "pending", attempts: 1 });
});
