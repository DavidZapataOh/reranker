import type { ClientBase } from "pg";

export type Queryable = Pick<ClientBase, "query">;

export type PlanNode = {
  "Node Type": string;
  "Relation Name"?: string;
  Schema?: string;
  Plans?: PlanNode[];
};

export type ExplainPlan = {
  Plan: PlanNode;
  "Planning Time": number;
  "Execution Time": number;
};

// Test-only: the SQL is a literal from the test, never external input.
export async function explain(
  db: Queryable,
  sql: string,
  params?: unknown[],
): Promise<ExplainPlan> {
  const { rows } = await db.query(`EXPLAIN (ANALYZE, VERBOSE, FORMAT JSON) ${sql}`, params);
  return rows[0]["QUERY PLAN"][0];
}

function* walk(node: PlanNode): Generator<PlanNode> {
  yield node;
  for (const child of node.Plans ?? []) yield* walk(child);
}

export function expectNoSeqScanOn(plan: ExplainPlan, table: string): void {
  const dot = table.lastIndexOf(".");
  const schema = dot === -1 ? undefined : table.slice(0, dot);
  const name = table.slice(dot + 1);
  for (const node of walk(plan.Plan)) {
    const scansTable =
      node["Node Type"] === "Seq Scan" &&
      node["Relation Name"] === name &&
      (schema === undefined || node.Schema === schema);
    if (scansTable) {
      throw new Error(`Seq Scan on "${table}"\n${summarize(plan.Plan)}`);
    }
  }
}

function summarize(root: PlanNode): string {
  return [...walk(root)]
    .map((n) => `${n["Node Type"]}${n["Relation Name"] ? ` on ${n["Relation Name"]}` : ""}`)
    .join(" > ");
}
