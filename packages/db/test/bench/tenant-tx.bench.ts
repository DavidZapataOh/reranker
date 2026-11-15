// Runs as a plain Node script (`pnpm db:bench`), not under Vitest, so the runner adds nothing to
// the timings and the percentiles come from the raw samples.
import { writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { createNeonClient } from "@neon/sdk";
import { type ExplainPlan, expectNoSeqScanOn, type PlanNode } from "@reranker/testing/db";
import { createTenant } from "@reranker/testing/factories";
import { getTestDatabaseUrl } from "@reranker/testing/neon";
import { eq, sql } from "drizzle-orm";
import pg from "pg";
import { runMigrations } from "../../scripts/migrate";
import { endPools, verifiedTlsUrl } from "../../src/client";
import { type TenantId, withSystem, withTenant } from "../../src/tenancy";
import { createScratchDatabase, type ScratchDatabase } from "../helpers";
import { onDatabase, probeStatements } from "../probe/database";
import { isolationProbe } from "../probe/isolation-probe.schema";

const TENANTS = 100;
const ROWS_PER_TENANT = 1000;
const WARMUP = 50;
const ITERATIONS = 1000;
const OVERHEAD_BUDGET_MS = 5;
const IDLE_TIMEOUT_MS = 120_000;
const REPORT = fileURLToPath(new URL("../../bench-report.json", import.meta.url));

type Report = {
  overheadP95Ms: number;
  pkP95Ms: number;
  tenantP95Ms: number;
  explain: { nodeType: string; indexName: string | null; hasInitPlan: boolean };
  coldStartMs: number | null;
  firstQueryOk: boolean | null;
  coldStartError?: string;
};

type Node = PlanNode & {
  "Index Name"?: string;
  "Parent Relationship"?: string;
  "Subplan Name"?: string;
  Output?: string[];
  Filter?: string;
  Plans?: Node[];
};

function p95(samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * 0.95) - 1] ?? Number.NaN;
}

const round = (ms: number) => Math.round(ms * 100) / 100;

async function seed(): Promise<{ tenant: TenantId; id: string }[]> {
  const tenants = await withSystem("bench.seed", async (tx) => {
    const ids: TenantId[] = [];
    while (ids.length < TENANTS) ids.push(await createTenant(tx));
    return ids;
  });
  const rows: { tenant: TenantId; id: string }[] = [];
  for (const tenant of tenants) {
    const values = Array.from({ length: ROWS_PER_TENANT }, (_, i) => ({
      tenantId: tenant,
      label: `row ${i}`,
    }));
    const inserted = await withSystem("bench.seed", (tx) =>
      tx.insert(isolationProbe).values(values).returning({ id: isolationProbe.id }),
    );
    for (const { id } of inserted) rows.push({ tenant, id });
  }
  return rows;
}

const pick = <T>(items: readonly T[]): T => items[Math.floor(Math.random() * items.length)] as T;

const selectById = (tenant: TenantId, id: string) =>
  withTenant(tenant, (tx) => tx.select().from(isolationProbe).where(eq(isolationProbe.id, id)));

// Both variants alternate inside one loop so network jitter on the runner hits them equally.
async function measure(baseline: pg.Pool, rows: readonly { tenant: TenantId; id: string }[]) {
  const raw: number[] = [];
  const tenant: number[] = [];
  for (let i = 0; i < WARMUP + ITERATIONS; i++) {
    const row = pick(rows);
    let start = performance.now();
    const plain = await baseline.query("select * from app.isolation_probe where id = $1", [row.id]);
    const rawMs = performance.now() - start;
    start = performance.now();
    const scoped = await selectById(row.tenant, row.id);
    const tenantMs = performance.now() - start;
    if (plain.rowCount !== 1 || scoped.length !== 1) {
      throw new Error(`row ${row.id} not found (raw ${plain.rowCount}, tenant ${scoped.length})`);
    }
    if (i >= WARMUP) {
      raw.push(rawMs);
      tenant.push(tenantMs);
    }
  }
  return { pkP95Ms: p95(raw), tenantP95Ms: p95(tenant) };
}

function* walk(node: Node): Generator<Node> {
  yield node;
  for (const child of node.Plans ?? []) yield* walk(child);
}

// app.current_tenant_ids() is an inlinable SQL function, so the plan may show its body
// (current_setting('app.tenant_ids')) instead of its name.
async function explainLookup(row: { tenant: TenantId; id: string }) {
  const [result] = await withTenant(row.tenant, async (tx) => {
    const query = tx.select().from(isolationProbe).where(eq(isolationProbe.id, row.id));
    const { rows } = await tx.execute<{ "QUERY PLAN": ExplainPlan[] }>(
      sql`explain (analyze, buffers, verbose, format json) ${query}`,
    );
    return rows[0]?.["QUERY PLAN"] ?? [];
  });
  if (!result) throw new Error("EXPLAIN returned no plan");
  expectNoSeqScanOn(result, "app.isolation_probe");
  const root = result.Plan as Node;
  const initPlans = [...walk(root)].filter(
    (node) =>
      node["Parent Relationship"] === "InitPlan" &&
      (node.Output ?? []).some((out) => /current_tenant_ids|app\.tenant_ids/.test(out)),
  );
  const hasInitPlan = initPlans.some(
    (node) => node["Subplan Name"] !== undefined && root.Filter?.includes(node["Subplan Name"]),
  );
  return {
    plan: result,
    explain: {
      nodeType: root["Node Type"],
      indexName: root["Index Name"] ?? null,
      hasInitPlan,
    },
  };
}

// Suspends the compute of the CI run's own throwaway branch; anything else is refused before
// the API is asked to suspend.
async function coldStart(row: { tenant: TenantId; id: string }, pooledUrl: string) {
  const apiKey = process.env.NEON_API_KEY;
  const projectId = process.env.NEON_PROJECT_ID;
  const branchId = process.env.NEON_BRANCH_ID;
  if (!apiKey || !projectId || !branchId) {
    throw new Error("NEON_API_KEY, NEON_PROJECT_ID and NEON_BRANCH_ID are required");
  }
  const neon = createNeonClient({ apiKey, throwOnError: true });
  const branch = await neon.branches.get({ projectId, branchId });
  if (!branch.name.startsWith("ci/") || branch.default || branch.protected) {
    throw new Error(`refusing to suspend branch "${branch.name}": not a CI branch`);
  }
  const endpoints = await neon.postgres.endpoints.listByBranch({ projectId, branchId });
  const endpoint = endpoints.find((e) => e.type === "read_write" && e.branch_id === branchId);
  const host = new URL(pooledUrl).hostname;
  if (!endpoint || !host.startsWith(`${endpoint.id}-pooler.`)) {
    throw new Error(`the benchmark database is not served by branch "${branch.name}"`);
  }

  await neon.postgres.endpoints.suspend({ projectId, endpointId: endpoint.id });
  const deadline = Date.now() + IDLE_TIMEOUT_MS;
  for (;;) {
    const current = await neon.postgres.endpoints.get({ projectId, endpointId: endpoint.id });
    if (current.current_state === "idle") break;
    if (Date.now() > deadline) throw new Error(`endpoint still ${current.current_state}`);
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  const start = performance.now();
  try {
    const rows = await selectById(row.tenant, row.id);
    return { coldStartMs: round(performance.now() - start), firstQueryOk: rows.length === 1 };
  } catch (error) {
    return {
      coldStartMs: round(performance.now() - start),
      firstQueryOk: false,
      coldStartError: error instanceof Error ? error.message : String(error),
    };
  }
}

async function main(): Promise<string[]> {
  const pooled = { app: getTestDatabaseUrl("app"), system: getTestDatabaseUrl("system") };
  // CI must always measure the cold start; locally it needs a key for a throwaway branch.
  const withColdStart = Boolean(process.env.CI || process.env.NEON_API_KEY);
  let scratch: ScratchDatabase | undefined;
  let baseline: pg.Pool | undefined;
  try {
    scratch = await createScratchDatabase("bench");
    await runMigrations({
      url: scratch.url,
      migrationsFolder: fileURLToPath(new URL("../../migrations", import.meta.url)),
      concurrentFolder: fileURLToPath(new URL("../../migrations/concurrent", import.meta.url)),
    });
    const owner = new pg.Client({ connectionString: scratch.url });
    await owner.connect();
    try {
      for (const statement of await probeStatements()) await owner.query(statement);
    } finally {
      await owner.end();
    }
    const target = {
      app: onDatabase(pooled.app, scratch.name),
      system: onDatabase(pooled.system, scratch.name),
    };
    // The pools read these on first use.
    process.env.DATABASE_URL = target.app;
    process.env.DATABASE_URL_SYSTEM = target.system;

    const rows = await seed();
    // The system login cannot ANALYZE a table it does not own.
    const analyzer = new pg.Client({ connectionString: scratch.url });
    await analyzer.connect();
    try {
      await analyzer.query("analyze app.isolation_probe");
    } finally {
      await analyzer.end();
    }

    baseline = new pg.Pool({
      connectionString: verifiedTlsUrl(target.system),
      max: 1,
      idleTimeoutMillis: 5000,
      connectionTimeoutMillis: 2000,
    });
    const { pkP95Ms, tenantP95Ms } = await measure(baseline, rows);
    const { plan, explain } = await explainLookup(pick(rows));
    await baseline.end();
    baseline = undefined;

    let cold: Pick<Report, "coldStartMs" | "firstQueryOk" | "coldStartError"> = {
      coldStartMs: null,
      firstQueryOk: null,
    };
    if (withColdStart) {
      // A suspended compute has dropped every connection, so the first visitor opens a new one.
      await endPools();
      cold = await coldStart(pick(rows), target.app);
    }

    const report: Report = {
      overheadP95Ms: round(tenantP95Ms - pkP95Ms),
      pkP95Ms: round(pkP95Ms),
      tenantP95Ms: round(tenantP95Ms),
      explain,
      ...cold,
    };
    await writeFile(REPORT, `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify(report));

    const failures: string[] = [];
    if (!(report.overheadP95Ms <= OVERHEAD_BUDGET_MS)) {
      failures.push(
        `withTenant overhead p95 ${report.overheadP95Ms} ms > ${OVERHEAD_BUDGET_MS} ms`,
      );
    }
    if (explain.nodeType !== "Index Scan" || explain.indexName !== "isolation_probe_pkey") {
      failures.push(`lookup plan is ${explain.nodeType} on ${explain.indexName}, not the pkey`);
    }
    if (!explain.hasInitPlan) failures.push("tenant filter is not an InitPlan");
    if (!explain.hasInitPlan || explain.nodeType !== "Index Scan") {
      console.log(JSON.stringify(plan.Plan, null, 2));
    }
    if (withColdStart && report.firstQueryOk !== true) {
      failures.push(`first query after scale-to-zero failed: ${report.coldStartError ?? "no row"}`);
    }
    return failures;
  } finally {
    await baseline?.end();
    await endPools();
    await scratch?.drop();
  }
}

try {
  const failures = await main();
  for (const failure of failures) console.error(`::error::${failure}`);
  process.exitCode = failures.length === 0 ? 0 : 1;
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
