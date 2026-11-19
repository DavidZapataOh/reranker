import { withSystem } from "@reranker/db";
import { evidenceBatches } from "@reranker/db/schema";
import { desc, eq, type SQL, sql } from "drizzle-orm";
import { loadSigner } from "../signer";
import { formatCheckpoint, signCheckpoint } from "./checkpoint";
import { extendTree } from "./frontier";
import { publishPendingBatches } from "./tiles";

export type IntegrateResult =
  | { status: "integrated"; treeSize: number; firstIndex: number }
  | { status: "empty" }
  | { status: "busy" };

/** The most entries one checkpoint appends; a longer queue continues in the next run. */
export const MAX_BATCH_ENTRIES = 5000;

const HASH_BYTES = 32;

type Pending = {
  src: "capture" | "entry";
  ref: string;
  kind: string | null;
  revision: number;
  envelope_sha256: Buffer;
};

function splitHashes(bytes: Buffer): Uint8Array[] {
  const hashes: Uint8Array[] = [];
  for (let i = 0; i < bytes.length; i += HASH_BYTES) {
    hashes.push(new Uint8Array(bytes.subarray(i, i + HASH_BYTES)));
  }
  return hashes;
}

/**
 * The next entries of the log, locked, in envelope order. Each branch walks its partial pending
 * index in order. The log's lock is per origin, so the row locks are what keep an integrator of
 * another origin from taking the same entries.
 */
export function pendingEntriesQuery(limit = MAX_BATCH_ENTRIES): SQL {
  return sql`
    with pending_captures as (
      select 'capture' as src, id as ref, null::text as kind, 0 as revision, envelope_sha256
      from public_panel.captures
      where log_index is null
      order by envelope_sha256
      limit ${limit}
      for update
    ), pending_entries as (
      select 'entry' as src, ref, kind::text, revision::int, envelope_sha256
      from public_panel.evidence_entries
      where log_index is null
      order by envelope_sha256
      limit ${limit}
      for update
    )
    select * from pending_captures
    union all
    select * from pending_entries
    order by envelope_sha256
    limit ${limit}`;
}

/**
 * Appends every pending entry of the log, captures and other statements alike, in envelope
 * order, and signs a checkpoint of the new tree. Concurrent calls get `busy` instead of waiting
 * on the log's lock, so two integrators never hand out the same index; one that dies holding the
 * lock rolls back and frees it.
 */
export async function integrate(origin: string): Promise<IntegrateResult> {
  // A batch whose publication died is served before the log grows past it; until R2 takes it,
  // entries keep waiting rather than piling up behind an unpublished checkpoint.
  await publishPendingBatches(origin);
  return withSystem(
    "evidence.integrate",
    async (tx): Promise<IntegrateResult> => {
      // The two-key form keeps this lock apart from every single-key advisory lock.
      const {
        rows: [lock],
      } = await tx.execute<{ locked: boolean }>(
        sql`select pg_try_advisory_xact_lock(hashtext('public_panel.evidence_batches'), hashtext(${origin})) as locked`,
      );
      if (!lock?.locked) return { status: "busy" };

      const { rows: pending } = await tx.execute<Pending>(pendingEntriesQuery());
      if (pending.length === 0) return { status: "empty" };
      // Before any write, so a deployment without its log key fails closed at once.
      const signer = await loadSigner("log");

      const [last] = await tx
        .select({ treeSize: evidenceBatches.treeSize, frontier: evidenceBatches.frontier })
        .from(evidenceBatches)
        .where(eq(evidenceBatches.origin, origin))
        .orderBy(desc(evidenceBatches.treeSize))
        .limit(1);
      const firstIndex = last?.treeSize ?? 0;
      const tree = await extendTree(
        firstIndex,
        last ? splitHashes(last.frontier) : [],
        pending.map((p) => new Uint8Array(p.envelope_sha256)),
      );

      const captures = pending.flatMap((p, i) =>
        p.src === "capture" ? [{ id: p.ref, index: firstIndex + i }] : [],
      );
      const entries = pending.flatMap((p, i) =>
        p.src === "entry" ? [{ ...p, index: firstIndex + i }] : [],
      );
      // log_index goes from null to its value once; the append-only triggers reject anything else.
      let assigned = 0;
      if (captures.length > 0) {
        const { rowCount } = await tx.execute(sql`
          update public_panel.captures c set log_index = v.log_index
          from unnest(${sql.param(captures.map((c) => c.id))}::text[],
                      ${sql.param(captures.map((c) => c.index))}::bigint[]) as v(id, log_index)
          where c.id = v.id and c.log_index is null`);
        assigned += rowCount ?? 0;
      }
      if (entries.length > 0) {
        const { rowCount } = await tx.execute(sql`
          update public_panel.evidence_entries e set log_index = v.log_index
          from unnest(${sql.param(entries.map((e) => e.ref))}::text[],
                      ${sql.param(entries.map((e) => e.kind))}::public_panel.evidence_entry_kind[],
                      ${sql.param(entries.map((e) => e.revision))}::smallint[],
                      ${sql.param(entries.map((e) => e.index))}::bigint[])
                 as v(ref, kind, revision, log_index)
          where e.ref = v.ref and e.kind = v.kind and e.revision = v.revision
            and e.log_index is null`);
        assigned += rowCount ?? 0;
      }
      if (assigned !== pending.length) {
        throw new Error(`Assigned ${assigned} of ${pending.length} log indexes`);
      }

      // Signed under the origin, the key name C2SP checkpoints recommend.
      const note = await signCheckpoint(
        formatCheckpoint({ origin, size: tree.size, root: tree.root }),
        signer,
        origin,
      );
      await tx.insert(evidenceBatches).values({
        origin,
        treeSize: tree.size,
        firstIndex,
        root: Buffer.from(tree.root),
        frontier: Buffer.concat(tree.frontier),
        checkpointNote: note,
      });
      return { status: "integrated", treeSize: tree.size, firstIndex };
    },
    { statementTimeoutMs: 10_000 },
  );
}
