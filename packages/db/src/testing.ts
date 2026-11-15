import { getTableColumns, getTableName } from "drizzle-orm";
import { getTableConfig, type PgColumn, type PgTable } from "drizzle-orm/pg-core";
import type { SystemTx, TenantId } from "./tenancy";

export type TenantFixture<T extends PgTable = PgTable> = {
  readonly name: string;
  readonly table: T;
  readonly id: PgColumn;
  readonly tenantId: PgColumn;
  /** Values for one row owned by `tenantId`; may insert the parent rows it points to through `tx`. */
  readonly build: (tenantId: TenantId, tx: SystemTx) => Promise<T["$inferInsert"]>;
};

/**
 * Registers how to build one row of a tenant table so the isolation suite can prove, with the
 * real runtime roles, that no tenant reads or writes another tenant's rows in it. Every table in
 * `app` needs one in `packages/db/test/fixtures/<table>.ts`; the catalog gate fails without it.
 */
export function defineTenantFixture<T extends PgTable>(
  table: T,
  build: (tenantId: TenantId, tx: SystemTx) => T["$inferInsert"] | Promise<T["$inferInsert"]>,
): TenantFixture<T> {
  const name = getTableName(table);
  if (getTableConfig(table).schema !== "app") {
    throw new Error(`${name}: tenant fixtures are only for tables in the app schema`);
  }
  // The keys tenantTable gives them; with snake_case casing the column names may still be camelCase.
  const { id, tenantId }: Record<string, PgColumn | undefined> = getTableColumns(table);
  if (!id || !tenantId) throw new Error(`${name}: a tenant table needs id and tenant_id columns`);
  return { name, table, id, tenantId, build: async (tenant, tx) => build(tenant, tx) };
}
