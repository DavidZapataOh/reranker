import { createHash, randomUUID } from "node:crypto";
import { asTenantId, endPools, withSystem, withTenant } from "@reranker/db";
import type { EntityKey } from "@reranker/schema/measurement";
import { sql } from "drizzle-orm";
import { afterAll, expect, test } from "vitest";
import { estimateRows, persistEstimates } from "../src/persist";
import { computeFreeReportStats } from "../src/report";
import { ladder, reportInput, TARGET } from "./fixtures/report-200";

afterAll(() => endPools());

// Real keys are place: plus a 27-character place id, so measured sizes match production.
const placeKey = (key: EntityKey): EntityKey =>
  `place:ChIJ${createHash("sha256").update(key).digest("base64url").slice(0, 23)}`;

const stats = computeFreeReportStats(
  reportInput(
    {
      mentions: (slot) => ladder(slot).map((m) => ({ ...m, entityKey: placeKey(m.entityKey) })),
      // Enough distinct sites that every top list is full, as in a real report.
      sources: (slot) => [
        ...(slot % 2 === 0 ? [{ url: "https://www.clinicasonrisas.com.co/", cited: true }] : []),
        ...(slot % 2 === 1 ? [{ url: "https://www.topdoctors.com.co/x", cited: true }] : []),
        ...[0, 1, 2].map((k) => ({
          url: `https://site${(slot + k * 5) % 15}.com.co/`,
          cited: true,
        })),
      ],
    },
    {
      target: {
        entityKey: placeKey(TARGET),
        displayName: "Clínica Sonrisas",
        entityKind: "business",
        domains: ["clinicasonrisas.com.co"],
      },
    },
  ),
);

// Rows and index entries of one report, pages included: about 480 bytes a row, a third of it the
// report's four 32-byte digests. The 22 score and rate rows measured 10.3 KiB; citations add up
// to 76 rows when every top list is full. The bound stops any further growth.
const REPORT_BUDGET_BYTES = 48 * 1024;

async function measurement(): Promise<string> {
  return withSystem("stats.test", async (tx) => {
    const { rows } = await tx.execute<{ id: string }>(
      sql`insert into public_panel.measurement_plans (purpose, ref_type, ref_id)
          values ('free-report', 'report', ${randomUUID()}) returning id`,
    );
    return rows[0]?.id as string;
  });
}

const rowsOf = (id: string) =>
  withSystem("stats.test", async (tx) => {
    const { rows } = await tx.execute<Record<string, unknown>>(
      sql`select * from public_panel.estimates where measurement_id = ${id} order by id`,
    );
    return rows;
  });

const storedBytes = () =>
  withSystem("stats.test", async (tx) => {
    const { rows } = await tx.execute<{ bytes: string }>(
      sql`select sum(pg_relation_size(c.oid, 'main'))::text as bytes from pg_class c
          where c.oid = 'public_panel.estimates'::regclass
             or c.oid in (select indexrelid from pg_index where indrelid = 'public_panel.estimates'::regclass)`,
    );
    return Number(rows[0]?.bytes);
  });

const ROWS = estimateRows(randomUUID(), stats).length;

test("persists exactly the rows the report shows, citations included", async () => {
  expect(ROWS).toBe(22 + 6 + 10 + 50 + stats.citations.competitorOnly.length);
  const id = await measurement();
  expect(await persistEstimates(id, stats)).toEqual({ inserted: ROWS });
  const rows = await rowsOf(id);
  expect(rows).toHaveLength(ROWS);
  expect(rows.map((r) => `${r.entity_key}|${r.scope}|${r.scope_key}|${r.metric}`).sort()).toEqual(
    estimateRows(id, stats)
      .map((r) => `${r.entityKey}|${r.scope}|${r.scopeKey}|${r.metric}`)
      .sort(),
  );
  expect(rows[0]).toMatchObject({
    methodology_hash: Buffer.from(stats.methodologyHash, "hex"),
    seed: Buffer.from(stats.seed, "hex"),
  });
});

test("idempotent: a second call inserts nothing and changes nothing", async () => {
  const id = await measurement();
  await persistEstimates(id, stats);
  const before = await rowsOf(id);
  expect(await persistEstimates(id, stats)).toEqual({ inserted: 0 });
  expect(await rowsOf(id)).toEqual(before);
});

test("a new methodology version adds rows and never updates old ones", async () => {
  const id = await measurement();
  await persistEstimates(id, stats);
  const before = await rowsOf(id);
  const next = { ...stats, methodologyHash: "d".repeat(64), seed: "e".repeat(64) };
  expect(await persistEstimates(id, next)).toEqual({ inserted: ROWS });
  const after = await rowsOf(id);
  expect(after).toHaveLength(2 * ROWS);
  expect(after.filter((r) => before.some((b) => b.id === r.id))).toEqual(before);
});

test("one report stays within its storage budget, measured over many batched reports", async () => {
  // A warm-up report allocates the index metapages and roots, which no later report pays for.
  await persistEstimates(await measurement(), stats);
  const reports = 100;
  const before = await storedBytes();
  for (let i = 0; i < reports; i++) await persistEstimates(await measurement(), stats);
  const perReport = ((await storedBytes()) - before) / reports;
  console.info(`estimates per report: ${ROWS} rows, ${perReport.toFixed(0)} bytes`);
  expect(perReport).toBeLessThanOrEqual(REPORT_BUDGET_BYTES);
}, 120_000);

test("tenants read estimates and cannot write them", async () => {
  const tenant = asTenantId(randomUUID());
  await expect(
    withTenant(tenant, (tx) => tx.execute(sql`select 1 from public_panel.estimates limit 1`)),
  ).resolves.toBeDefined();
  await expect(
    withTenant(tenant, (tx) => tx.execute(sql`delete from public_panel.estimates`)),
  ).rejects.toMatchObject({ cause: { code: "42501" } });
});
