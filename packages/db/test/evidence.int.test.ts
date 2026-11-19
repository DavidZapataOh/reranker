import { createHash, randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { expectNoSeqScanOn, explain } from "@reranker/testing/db";
import { getTestDatabaseUrl } from "@reranker/testing/neon";
import pg from "pg";
import { afterAll, beforeAll, expect, test } from "vitest";
import { runMigrations } from "../scripts/migrate";
import { runCatalogGate } from "./catalog-gate";
import { createScratchDatabase, type ScratchDatabase } from "./helpers";
import { onDatabase } from "./probe/database";

// Each table with a column a no-op update can name.
const EVIDENCE_TABLES: Record<string, string> = {
  evidence_entries: "ref",
  evidence_batches: "origin",
  timestamp_anchors: "origin",
  signing_keys: "keyid",
  artifact_removals: "sha256",
  evidence_tree_hashes: "origin",
};
const TABLE_NAMES = Object.keys(EVIDENCE_TABLES);
const ORIGIN = "log.reranker.co/captures/2026";

let scratch: ScratchDatabase;
let owner: pg.Client;
let system: pg.Client;
let app: pg.Client;

const sha = (seed: string) => createHash("sha256").update(seed).digest();

async function connect(url: string): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  return client;
}

beforeAll(async () => {
  scratch = await createScratchDatabase("evidence");
  await runMigrations({
    url: scratch.url,
    migrationsFolder: fileURLToPath(new URL("../migrations", import.meta.url)),
    concurrentFolder: fileURLToPath(new URL("../migrations/concurrent", import.meta.url)),
  });
  owner = await connect(scratch.url);
  system = await connect(onDatabase(getTestDatabaseUrl("system"), scratch.name));
  app = await connect(onDatabase(getTestDatabaseUrl("app"), scratch.name));
}, 180_000);

afterAll(async () => {
  await Promise.allSettled([owner?.end(), system?.end(), app?.end()]);
  await scratch?.drop();
});

const sys = (sql: string, values?: unknown[]) => system.query(sql, values);

let nextTreeSize = 0;

// A C2SP checkpoint as the log signs it: origin, size, base64 root, blank line, one signature line
// with the 4-byte key ID and the 64-byte Ed25519 signature.
function checkpointNote(treeSize: number, root: Buffer): string {
  const signature = Buffer.concat([randomBytes(4), randomBytes(64)]).toString("base64");
  return `${ORIGIN}\n${treeSize}\n${root.toString("base64")}\n\n— ${ORIGIN} ${signature}\n`;
}

const popcount = (n: number) => n.toString(2).replaceAll("0", "").length;

async function insertBatch(treeSize = ++nextTreeSize, firstIndex = treeSize - 1): Promise<number> {
  const root = sha(`root:${treeSize}`);
  await sys(
    `insert into public_panel.evidence_batches
       (origin, tree_size, first_index, root, frontier, checkpoint_note)
     values ($1, $2, $3, $4, $5, $6)`,
    [
      ORIGIN,
      treeSize,
      firstIndex,
      root,
      randomBytes(32 * popcount(treeSize)),
      checkpointNote(treeSize, root),
    ],
  );
  return treeSize;
}

async function insertEntry(
  input: { ref?: string; kind?: string; logIndex?: number | null } = {},
): Promise<string> {
  const ref = input.ref ?? randomUUID();
  await sys(
    `insert into public_panel.evidence_entries (ref, kind, envelope_sha256, log_index)
     values ($1, $2, $3, $4)`,
    [ref, input.kind ?? "plan", sha(`envelope:${ref}`), input.logIndex ?? null],
  );
  return ref;
}

async function insertKey(keyid = `rr-capture-${randomUUID()}`): Promise<string> {
  await sys(
    `insert into public_panel.signing_keys (keyid, purpose, env, public_key, custody, valid_from)
     values ($1, 'capture', 'preview', $2, 'aws-kms-hsm', now())`,
    [keyid, randomBytes(32)],
  );
  return keyid;
}

test("the evidence tables pass the isolation catalog gate", async () => {
  const violations = await runCatalogGate(owner, new Set());
  expect(violations.filter((v) => TABLE_NAMES.includes(v.table))).toEqual([]);
  const { rows } = await owner.query<{ table: string }>(
    `select table_name as table from information_schema.tables
     where table_schema = 'public_panel' and table_name = any($1)`,
    [TABLE_NAMES],
  );
  expect(rows.map((row) => row.table).sort()).toEqual([...TABLE_NAMES].sort());
});

test.each(TABLE_NAMES)("app_tenant reads %s and cannot write it", async (table) => {
  const column = EVIDENCE_TABLES[table];
  await expect(app.query(`select count(*) from public_panel.${table}`)).resolves.toBeDefined();
  const writes = [
    table === "artifact_removals"
      ? `insert into public_panel.artifact_removals (sha256, kind, reason)
         values ('\\x00', 'raw', 'legal_order')`
      : `insert into public_panel.${table} default values`,
    `update public_panel.${table} set ${column} = ${column}`,
    `delete from public_panel.${table}`,
  ];
  for (const sql of writes) {
    await expect(app.query(sql)).rejects.toMatchObject({ code: "42501" });
  }
});

test("batches reject delete and any update except setting published_at once", async () => {
  const size = await insertBatch();
  const where = `where origin = '${ORIGIN}' and tree_size = ${size}`;
  await expect(
    sys(`update public_panel.evidence_batches set root = $1 ${where}`, [sha("other")]),
  ).rejects.toThrow(/immutable/);
  await expect(
    sys(`update public_panel.evidence_batches set checkpoint_note = 'x' ${where}`),
  ).rejects.toThrow(/immutable/);
  await expect(sys(`delete from public_panel.evidence_batches ${where}`)).rejects.toThrow(
    /immutable/,
  );
  await sys(`update public_panel.evidence_batches set published_at = now() ${where}`);
  await expect(
    sys(`update public_panel.evidence_batches set published_at = now() ${where}`),
  ).rejects.toThrow(/immutable/);
  await expect(
    sys(`update public_panel.evidence_batches set published_at = null ${where}`),
  ).rejects.toThrow(/immutable/);
});

test("a batch's root is 32 bytes and its frontier whole hashes, at most 64", async () => {
  const size = ++nextTreeSize;
  const insert = (root: Buffer, frontier: Buffer, firstIndex = size - 1) =>
    sys(
      `insert into public_panel.evidence_batches
         (origin, tree_size, first_index, root, frontier, checkpoint_note)
       values ($1, $2, $3, $4, $5, 'note')`,
      [ORIGIN, size, firstIndex, root, frontier],
    );
  const rejected: [root: number, frontier: number, firstIndex?: number][] = [
    [31, 32],
    [32, 33],
    [32, 0],
    [32, 65 * 32],
    [32, 32, size],
  ];
  for (const [root, frontier, firstIndex] of rejected) {
    await expect(
      insert(Buffer.alloc(root), Buffer.alloc(frontier), firstIndex),
    ).rejects.toMatchObject({ code: "23514" });
  }
  await expect(insert(Buffer.alloc(32), Buffer.alloc(64 * 32))).resolves.toBeDefined();
});

test("log_index is assigned once and nothing else in an entry ever changes", async () => {
  const ref = await insertEntry();
  const where = `where ref = '${ref}' and kind = 'plan' and revision = 0`;
  await expect(
    sys(`update public_panel.evidence_entries set envelope_sha256 = $1 ${where}`, [sha("x")]),
  ).rejects.toThrow(/immutable/);
  await expect(
    sys(`update public_panel.evidence_entries set normalized_sha256 = $1 ${where}`, [sha("x")]),
  ).rejects.toThrow(/immutable/);
  await expect(
    sys(`update public_panel.evidence_entries set signed_at = now() - interval '1 day' ${where}`),
  ).rejects.toThrow(/immutable/);
  await expect(
    sys(`update public_panel.evidence_entries set revision = 1 ${where}`),
  ).rejects.toThrow(/immutable/);
  await sys(`update public_panel.evidence_entries set log_index = 2000001 ${where}`);
  await expect(
    sys(`update public_panel.evidence_entries set log_index = 2000002 ${where}`),
  ).rejects.toThrow(/immutable/);
  await expect(
    sys(`update public_panel.evidence_entries set log_index = null ${where}`),
  ).rejects.toThrow(/immutable/);
  await expect(sys(`delete from public_panel.evidence_entries ${where}`)).rejects.toThrow(
    /immutable/,
  );
});

test("an entry is unique per (ref, kind, revision) and per log_index", async () => {
  const ref = await insertEntry({ logIndex: 3000001 });
  await expect(insertEntry({ ref })).rejects.toMatchObject({ code: "23505" });
  await expect(insertEntry({ ref, kind: "reparse" })).resolves.toBe(ref);
  await expect(insertEntry({ logIndex: 3000001 })).rejects.toMatchObject({ code: "23505" });
  await expect(
    sys(
      `insert into public_panel.evidence_entries (ref, kind, envelope_sha256)
       values ($1, 'plan', $2)`,
      [randomUUID(), Buffer.alloc(33)],
    ),
  ).rejects.toMatchObject({ code: "23514" });
});

test("evidence_entry_kind has no capture value", async () => {
  const { rows } = await owner.query<{ kinds: string[] }>(
    "select enum_range(null::public_panel.evidence_entry_kind)::text[] as kinds",
  );
  expect(rows[0]?.kinds).toEqual(["plan", "reparse", "consent", "key", "regime", "extraction"]);
});

test("signing keys only close their validity, once, and are never deleted", async () => {
  const keyid = await insertKey();
  const where = `where keyid = '${keyid}'`;
  await expect(
    sys(`update public_panel.signing_keys set public_key = $1 ${where}`, [randomBytes(32)]),
  ).rejects.toThrow(/immutable/);
  await expect(
    sys(`update public_panel.signing_keys set custody = 'gcp-kms-software' ${where}`),
  ).rejects.toThrow(/immutable/);
  await sys(`update public_panel.signing_keys set valid_to = now() + interval '1 day' ${where}`);
  await sys(`update public_panel.signing_keys set compromised_after = now() ${where}`);
  await expect(
    sys(`update public_panel.signing_keys set valid_to = now() + interval '2 days' ${where}`),
  ).rejects.toThrow(/immutable/);
  await expect(
    sys(`update public_panel.signing_keys set compromised_after = null ${where}`),
  ).rejects.toThrow(/immutable/);
  await expect(sys(`delete from public_panel.signing_keys ${where}`)).rejects.toThrow(/immutable/);
});

test("anchors pair each kind with its providers, once per batch, and only for existing batches", async () => {
  const size = await insertBatch();
  const anchor = (kind: string, provider: string, treeSize = size) =>
    sys(
      `insert into public_panel.timestamp_anchors (origin, tree_size, kind, provider, proof)
       values ($1, $2, $3, $4, $5)`,
      [ORIGIN, treeSize, kind, provider, randomBytes(512)],
    );
  await anchor("ots", "ots-calendars");
  await anchor("rfc3161", "qtsa");
  await anchor("rfc3161", "digicert");
  await expect(anchor("ots", "ots-calendars")).rejects.toMatchObject({ code: "23505" });
  await expect(anchor("ots", "digicert")).rejects.toMatchObject({ code: "23514" });
  await expect(anchor("rfc3161", "ots-calendars")).rejects.toMatchObject({ code: "23514" });
  await expect(anchor("ots", "ots-calendars", 999_999_999)).rejects.toMatchObject({
    code: "23503",
  });
  await expect(
    sys(
      `update public_panel.timestamp_anchors set status = 'confirmed', bitcoin_height = 900000,
         attested_at = now() where origin = $1 and tree_size = $2 and kind = 'ots'`,
      [ORIGIN, size],
    ),
  ).resolves.toMatchObject({ rowCount: 1 });
  await expect(
    sys(
      `update public_panel.timestamp_anchors set status = 'lost'
       where origin = $1 and tree_size = $2 and kind = 'ots'`,
      [ORIGIN, size],
    ),
  ).rejects.toMatchObject({ code: "23514" });
  await expect(
    sys(
      `update public_panel.timestamp_anchors set proof = $3
       where origin = $1 and tree_size = $2 and provider = 'qtsa'`,
      [ORIGIN, size, Buffer.alloc(10_241)],
    ),
  ).rejects.toMatchObject({ code: "23514" });
});

test("artifact removals hold one row per 32-byte digest with a closed kind and reason", async () => {
  const digest = randomBytes(32);
  const remove = (sha256: Buffer, kind = "raw", reason = "personal_data_request") =>
    sys(`insert into public_panel.artifact_removals (sha256, kind, reason) values ($1, $2, $3)`, [
      sha256,
      kind,
      reason,
    ]);
  await remove(digest);
  await expect(remove(digest)).rejects.toMatchObject({ code: "23505" });
  await expect(remove(randomBytes(31))).rejects.toMatchObject({ code: "23514" });
  await expect(remove(randomBytes(32), "tiles")).rejects.toMatchObject({ code: "23514" });
  await expect(remove(randomBytes(32), "raw", "because")).rejects.toMatchObject({ code: "23514" });
});

test("a recorded removal is never updated or deleted, and recording it again is a no-op", async () => {
  const digest = randomBytes(32);
  const record = `insert into public_panel.artifact_removals (sha256, kind, reason)
    values ($1, 'raw', 'personal_data_request') on conflict do nothing`;
  await sys(record, [digest]);
  await expect(sys(record, [digest])).resolves.toMatchObject({ rowCount: 0 });
  await expect(
    sys(`update public_panel.artifact_removals set reason = 'legal_order' where sha256 = $1`, [
      digest,
    ]),
  ).rejects.toThrow(/immutable/);
  await expect(
    sys(`update public_panel.artifact_removals set removed_at = now() where sha256 = $1`, [digest]),
  ).rejects.toThrow(/immutable/);
  await expect(
    sys(`delete from public_panel.artifact_removals where sha256 = $1`, [digest]),
  ).rejects.toThrow(/immutable/);
});

test("the pending entry queue uses its partial index with 10,000 rows", async () => {
  // Rolled back so the rows never count toward the other tests; the owner can ANALYZE them.
  await owner.query("begin");
  try {
    await owner.query(
      `insert into public_panel.evidence_entries (ref, kind, envelope_sha256, log_index)
       select gen_random_uuid()::text, 'plan', sha256(g::text::bytea),
         case when g % 10 = 0 then null else 4000000 + g end
       from generate_series(1, 10000) g`,
    );
    await owner.query("analyze public_panel.evidence_entries");
    const queryPlan = await explain(
      owner,
      "select envelope_sha256 from public_panel.evidence_entries where log_index is null order by envelope_sha256 limit 5000",
    );
    expectNoSeqScanOn(queryPlan, "public_panel.evidence_entries");
  } finally {
    await owner.query("rollback");
  }
});

// Sizes as Postgres stores them, as in capture.int.test.ts: each heap row plus its line pointer,
// and one entry per row in every index (8-byte tuple header and key, aligned to 8, plus its line
// pointer).
async function storedBytes(table: string, scope: string, values: unknown[]): Promise<number> {
  const { rows: heap } = await owner.query<{ b: number }>(
    `select coalesce(sum(pg_column_size(t.*) + 4), 0)::int as b from ${table} t where ${scope}`,
    values,
  );
  let total = heap[0]?.b ?? 0;
  const { rows: indexes } = await owner.query<{ columns: string[]; pred: string }>(
    `select array(select a.attname::text from unnest(i.indkey) k
             join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k) as columns,
       coalesce(pg_get_expr(i.indpred, i.indrelid), 'true') as pred
     from pg_index i where i.indrelid = $1::regclass`,
    [table],
  );
  expect(indexes.length).toBeGreaterThan(0);
  for (const index of indexes) {
    const key = index.columns.map((column) => `pg_column_size(${column})`).join(" + ");
    const { rows } = await owner.query<{ b: number }>(
      `select coalesce(sum(4 + ((8 + ${key} + 7) / 8) * 8), 0)::int as b
       from ${table} where ${scope} and (${index.pred})`,
      values,
    );
    total += rows[0]?.b ?? 0;
  }
  return total;
}

test("a report's plan entry and its batch stay within 1 KB of rows and index entries", async () => {
  // A report adds one plan entry and about one batch. 2,010,000 entries is a log of 10,000
  // reports, and its 11-hash frontier sits above the average for logs of that size.
  const treeSize = 2_010_000;
  await insertBatch(treeSize, treeSize - 201);
  const ref = await insertEntry({ logIndex: treeSize - 201 });
  const entry = await storedBytes(
    "public_panel.evidence_entries",
    "ref = $1 and kind = 'plan' and revision = 0",
    [ref],
  );
  const batch = await storedBytes(
    "public_panel.evidence_batches",
    "origin = $1 and tree_size = $2",
    [ORIGIN, treeSize],
  );
  console.info(
    `evidence entry+batch bytes per report: ${entry + batch} (entry ${entry}, batch ${batch})`,
  );
  expect(entry + batch).toBeLessThanOrEqual(1024);
});

test("a tree hash is one 32-byte hash per origin and stored index, never rewritten", async () => {
  const index = ++nextTreeSize;
  const insert = (hash: Buffer) =>
    sys(
      `insert into public_panel.evidence_tree_hashes (origin, stored_index, hash)
       values ($1, $2, $3)`,
      [ORIGIN, index, hash],
    );
  await insert(sha("node"));
  await expect(insert(sha("other"))).rejects.toMatchObject({ code: "23505" });
  await expect(
    sys(
      `insert into public_panel.evidence_tree_hashes (origin, stored_index, hash)
         values ($1, $2, $3)`,
      [ORIGIN, index + 1, randomBytes(31)],
    ),
  ).rejects.toMatchObject({ code: "23514" });
  const where = `where origin = '${ORIGIN}' and stored_index = ${index}`;
  await expect(
    sys(`update public_panel.evidence_tree_hashes set hash = $1 ${where}`, [sha("other")]),
  ).rejects.toThrow(/immutable/);
  await expect(sys(`delete from public_panel.evidence_tree_hashes ${where}`)).rejects.toThrow(
    /immutable/,
  );
});
