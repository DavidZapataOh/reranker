import type { ClientBase } from "pg";

export type Queryable = Pick<ClientBase, "query">;

export type PlanNode = {
  "Node Type": string;
  "Relation Name"?: string;
  Schema?: string;
  Plans?: PlanNode[];
};

export type GenericPlan = { Plan: PlanNode };

export type ExplainPlan = GenericPlan & {
  "Planning Time": number;
  "Execution Time": number;
};

// Test-only: the SQL is a literal from the test, never external input.
// ANALYZE executes the statement, so run writes inside a transaction the test rolls back.
export async function explain(
  db: Queryable,
  sql: string,
  params?: unknown[],
): Promise<ExplainPlan> {
  const { rows } = await db.query(`EXPLAIN (ANALYZE, VERBOSE, FORMAT JSON) ${sql}`, params);
  return rows[0]["QUERY PLAN"][0];
}

/**
 * The generic plan of a statement with `$n` placeholders: the plan a server-side prepared statement
 * (a PL/pgSQL statement included) settles on after its first executions. Each placeholder needs a
 * cast so its type is known without values.
 */
export async function explainGeneric(db: Queryable, sql: string): Promise<GenericPlan> {
  const { rows } = await db.query(`EXPLAIN (GENERIC_PLAN, VERBOSE, FORMAT JSON) ${sql}`);
  return rows[0]["QUERY PLAN"][0];
}

function* walk(node: PlanNode): Generator<PlanNode> {
  yield node;
  for (const child of node.Plans ?? []) yield* walk(child);
}

export function expectNoSeqScanOn(plan: GenericPlan, table: string): void {
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
