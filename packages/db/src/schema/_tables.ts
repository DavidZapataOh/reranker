import { sql } from "drizzle-orm";
import type { BuildExtraConfigColumns } from "drizzle-orm/column-builder";
import {
  foreignKey,
  index,
  type PgColumn,
  type PgColumnBuilderBase,
  type PgTableExtraConfigValue,
  pgPolicy,
  unique,
} from "drizzle-orm/pg-core";
import { id, tenantId } from "./_columns";
import { appSystem, appTenant } from "./_roles";
import { appSchema, opsSchema, publicPanelSchema } from "./_schemas";

type Columns = Record<string, PgColumnBuilderBase>;
type Extra<TName extends string, TColumns extends Columns> = (
  self: BuildExtraConfigColumns<TName, TColumns, "pg">,
) => PgTableExtraConfigValue[];

type WithId<TColumns extends Columns> = { id: ReturnType<typeof id> } & TColumns;
type TenantColumns<TColumns extends Columns> = WithId<{ tenantId: ReturnType<typeof tenantId> }> &
  TColumns;

/**
 * A customer-data table in `app`: RLS with one policy per runtime group, plus the unique
 * (tenant_id, id) that composite same-tenant foreign keys target.
 */
export const tenantTable = <TName extends string, TColumns extends Columns>(
  name: TName,
  columns: TColumns,
  extra?: Extra<TName, TenantColumns<TColumns>>,
) =>
  appSchema
    // Explicit type arguments: inferring them from a spread of generic columns drops the added ones.
    .table<TName, TenantColumns<TColumns>>(
      name,
      { id: id(), tenantId: tenantId(), ...columns },
      (t) => {
        // The ::uuid[] cast makes Postgres read `any (...)` as an array comparison; without it the
        // parenthesised subquery is taken as ANY(subquery) and fails with "uuid = uuid[]".
        const ownTenant = sql`${t.tenantId} = any ((select app.current_tenant_ids())::uuid[])`;
        return [
          unique(`${name}_tenant_id_id_key`).on(t.tenantId, t.id),
          index(`${name}_tenant_id_idx`).on(t.tenantId),
          pgPolicy(`${name}_tenant_isolation`, {
            as: "permissive",
            for: "all",
            to: appTenant,
            using: ownTenant,
            withCheck: ownTenant,
          }),
          pgPolicy(`${name}_system_access`, {
            as: "permissive",
            for: "all",
            to: appSystem,
            using: sql`true`,
            withCheck: sql`true`,
          }),
          ...(extra?.(t) ?? []),
        ];
      },
    )
    .enableRLS();

/** Composite foreign key (tenant_id, x_id) → (tenant_id, id), so a row never points across tenants. */
export const sameTenant = (
  name: string,
  local: [tenant: PgColumn, ref: PgColumn],
  target: [tenant: PgColumn, id: PgColumn],
) => foreignKey({ name, columns: local, foreignColumns: target });

/** World data in `public_panel`: no tenant, readable by every tenant. */
export const sharedTable = <TName extends string, TColumns extends Columns>(
  name: TName,
  columns: TColumns,
  extra?: Extra<TName, WithId<TColumns>>,
) => publicPanelSchema.table<TName, WithId<TColumns>>(name, { id: id(), ...columns }, extra);

/** System-only tables in `ops`; each declares its own primary key, natural or composite. */
export const opsTable = <TName extends string, TColumns extends Columns>(
  name: TName,
  columns: TColumns,
  extra?: Extra<TName, TColumns>,
) => opsSchema.table(name, columns, extra);
