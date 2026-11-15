import type pg from "pg";

export type GateViolation = { table: string; rule: string; message: string };

type TableRow = {
  schema: "app" | "auth" | "public_panel" | "ops";
  table: string;
  kind: string;
  rls: boolean;
  tenant_id_not_null: boolean | null;
  runtime_owner: boolean;
  public_grant: boolean;
  tenant_privileges: string[];
};
type PolicyRow = {
  table: string;
  permissive: boolean;
  cmd: string;
  roles: string[];
  tenant_applies: boolean;
  qual: string | null;
  check: string | null;
};
type IndexRow = { table: string; columns: string[]; unique: boolean; partial: boolean };
type ForeignKeyRow = {
  table: string;
  target_schema: string;
  target: string;
  columns: string[];
  target_columns: string[];
  on_delete: string;
};

const PRIVILEGES = ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"];

const TABLES = `
  select n.nspname as schema, c.relname as table, c.relkind as kind, c.relrowsecurity as rls,
    (select a.attnotnull from pg_attribute a
      where a.attrelid = c.oid and a.attname = 'tenant_id' and not a.attisdropped) as tenant_id_not_null,
    -- Owners bypass RLS unless it is forced, so no runtime role may own a tenant table.
    pg_has_role(c.relowner, 'app_tenant', 'USAGE') or pg_has_role(c.relowner, 'app_system', 'USAGE') as runtime_owner,
    has_table_privilege('public', c.oid, '${PRIVILEGES.join(",")}') as public_grant,
    array(select p from unnest($1::text[]) p where has_table_privilege('app_tenant', c.oid, p)) as tenant_privileges
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname in ('app', 'auth', 'public_panel', 'ops') and c.relkind in ('r', 'p', 'v', 'm', 'f')
  order by 1, 2`;

// A policy reaches the tenant runtime when it names PUBLIC or any role a non-superuser member of
// app_tenant has the privileges of (reranker_app, app_tenant itself, or a role they inherit).
const POLICIES = `
  select c.relname as table, p.polpermissive as permissive, p.polcmd as cmd,
    array(select case when r = 0 then 'public' else pg_get_userbyid(r) end from unnest(p.polroles) r) as roles,
    exists (
      select 1 from unnest(p.polroles) r
      where r = 0 or exists (
        select 1 from pg_roles m
        where not m.rolsuper and pg_has_role(m.oid, 'app_tenant', 'USAGE') and pg_has_role(m.oid, r, 'USAGE')
      )
    ) as tenant_applies,
    pg_get_expr(p.polqual, p.polrelid) as qual, pg_get_expr(p.polwithcheck, p.polrelid) as check
  from pg_policy p join pg_class c on c.oid = p.polrelid join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'app'`;

const COLUMNS = (rel: string, keys: string, count: string) => `
  array(select coalesce(a.attname, '<expression>')
    from unnest(${keys}::int2[]) with ordinality k(attnum, ord)
    left join pg_attribute a on a.attrelid = ${rel} and a.attnum = k.attnum
    where k.ord <= ${count} order by k.ord)`;

const INDEXES = `
  select c.relname as table, ${COLUMNS("i.indrelid", "i.indkey", "i.indnkeyatts")} as columns,
    i.indisunique as unique, i.indpred is not null as partial
  from pg_index i join pg_class c on c.oid = i.indrelid join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'app'`;

const FOREIGN_KEYS = `
  select c.relname as table, tn.nspname as target_schema, t.relname as target,
    ${COLUMNS("k.conrelid", "k.conkey", "cardinality(k.conkey)")} as columns,
    ${COLUMNS("k.confrelid", "k.confkey", "cardinality(k.confkey)")} as target_columns,
    k.confdeltype as on_delete
  from pg_constraint k
  join pg_class c on c.oid = k.conrelid join pg_namespace n on n.oid = c.relnamespace
  join pg_class t on t.oid = k.confrelid join pg_namespace tn on tn.oid = t.relnamespace
  where k.contype = 'f' and n.nspname = 'app'`;

// The exact policy expression the tenantTable builder emits, as Postgres deparses it. Anything
// else, even a superset such as `... or true`, could open rows to another tenant.
const TENANT_EXPRESSION =
  /^\(?(\w+\.)?tenant_id=any\(\(select(app\.)?current_tenant_ids\(\)(ascurrent_tenant_ids)?\)(::uuid\[\])?\)\)?$/;

const compact = (expression: string | null) => expression?.replace(/\s+/g, "").toLowerCase() ?? "";
const isTenantExpression = (expression: string | null) =>
  TENANT_EXPRESSION.test(compact(expression));

/**
 * Reads the live catalog and lists every way a table breaks the isolation contract: tenant tables
 * in `app` (RLS, both policies, indexes, same-tenant keys, fixture), shared tables in
 * `public_panel`, and the system-only `auth` and `ops`. An empty result means the schema is safe.
 */
export async function runCatalogGate(
  client: pg.ClientBase,
  fixtures: ReadonlySet<string>,
): Promise<GateViolation[]> {
  const [tables, policies, indexes, foreignKeys] = await Promise.all([
    client.query<TableRow>(TABLES, [PRIVILEGES]),
    client.query<PolicyRow>(POLICIES),
    client.query<IndexRow>(INDEXES),
    client.query<ForeignKeyRow>(FOREIGN_KEYS),
  ]);
  const violations: GateViolation[] = [];
  const fail = (row: TableRow, rule: string, missing: string) =>
    violations.push({
      table: row.table,
      rule,
      message: `${row.schema}.${row.table}: ${rule} — ${missing}`,
    });
  const byTable = <R extends { table: string }>(rows: R[], table: string) =>
    rows.filter((row) => row.table === table);

  for (const row of tables.rows) {
    if (row.public_grant) fail(row, "no_public_grants", "PUBLIC holds a privilege on the table");
    if (row.schema === "public_panel") {
      if (row.tenant_id_not_null !== null) {
        fail(row, "shared_no_tenant", "shared tables hold world data and carry no tenant_id");
      }
      const writes = row.tenant_privileges.filter((privilege) => privilege !== "SELECT");
      if (writes.length > 0) {
        fail(row, "shared_select_only", `app_tenant may only SELECT, has ${writes.join(", ")}`);
      }
      continue;
    }
    if (row.schema === "ops" || row.schema === "auth") {
      if (row.tenant_privileges.length > 0) {
        fail(
          row,
          `${row.schema}_no_tenant_privilege`,
          `app_tenant has ${row.tenant_privileges.join(", ")}`,
        );
      }
      continue;
    }

    if (row.tenant_id_not_null !== true) {
      fail(row, "tenant_id_not_null", "tenant_id uuid not null is missing or nullable");
    }
    if (!row.rls) fail(row, "rls_enabled", "row level security is not enabled");
    if (row.runtime_owner) fail(row, "runtime_not_owner", "a runtime role owns the table");
    if (!fixtures.has(row.table)) {
      fail(row, "fixture", `no fixture in packages/db/test/fixtures/${row.table}.ts`);
    }

    const own = byTable(policies.rows, row.table);
    const reachTenant = own.filter((policy) => policy.permissive && policy.tenant_applies);
    const tenantPolicy = reachTenant.some(
      (policy) =>
        policy.cmd === "*" &&
        policy.roles.includes("app_tenant") &&
        isTenantExpression(policy.qual),
    );
    const leaky = reachTenant.filter(
      (policy) =>
        (policy.qual !== null && !isTenantExpression(policy.qual)) ||
        (policy.check !== null && !isTenantExpression(policy.check)),
    );
    if (!tenantPolicy || leaky.length > 0) {
      fail(
        row,
        "tenant_policy",
        "every permissive policy reaching app_tenant must be for all, using and with check tenant_id = any ((select app.current_tenant_ids())::uuid[])",
      );
    }
    const systemPolicy = own.some(
      (policy) =>
        policy.permissive &&
        policy.cmd === "*" &&
        policy.roles.includes("app_system") &&
        compact(policy.qual) === "true" &&
        compact(policy.check) === "true",
    );
    if (!systemPolicy) {
      fail(row, "system_policy", "no policy for all to app_system using (true) with check (true)");
    }

    const ownIndexes = byTable(indexes.rows, row.table).filter((index) => !index.partial);
    if (!ownIndexes.some((index) => index.columns[0] === "tenant_id")) {
      fail(row, "tenant_index", "no index leads with tenant_id");
    }
    const tenantIdUnique = ownIndexes.some(
      (index) =>
        index.unique &&
        index.columns.length === 2 &&
        index.columns.includes("tenant_id") &&
        index.columns.includes("id"),
    );
    if (!tenantIdUnique) {
      fail(row, "tenant_id_id_unique", "no unique (tenant_id, id) for same-tenant foreign keys");
    }

    const keys = byTable(foreignKeys.rows, row.table);
    const cascades = keys.some(
      (key) =>
        key.target_schema === "auth" &&
        key.target === "organizations" &&
        key.columns.join() === "tenant_id" &&
        key.target_columns.join() === "id" &&
        key.on_delete === "c",
    );
    if (!cascades) {
      fail(
        row,
        "tenant_fk_cascade",
        "tenant_id must reference auth.organizations(id) on delete cascade",
      );
    }
    for (const key of keys.filter((k) => k.target_schema === "app")) {
      const position = key.columns.indexOf("tenant_id");
      if (position === -1 || key.target_columns[position] !== "tenant_id") {
        fail(
          row,
          "composite_fk",
          `the foreign key (${key.columns.join(", ")}) → app.${key.target} must pair tenant_id with tenant_id`,
        );
      }
    }
  }
  return violations;
}
