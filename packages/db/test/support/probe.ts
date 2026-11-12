import { sql } from "drizzle-orm";
import { text, uuid } from "drizzle-orm/pg-core";
import type pg from "pg";
import { appSchema } from "../../src/schema/index.ts";

/**
 * A tenant table with the two policies every app table carries, created by the migration owner so
 * the schema's default privileges grant it. Lives only on the CI branch, for the test's duration.
 */
export function probeTable(name: string) {
  return appSchema.table(name, {
    id: uuid().primaryKey().default(sql`uuidv7()`),
    tenantId: uuid().notNull(),
    label: text(),
  });
}

export async function createProbe(owner: pg.Client, name: string): Promise<void> {
  await owner.query(`drop table if exists app.${name}`);
  await owner.query(`
    create table app.${name} (
      id uuid primary key default uuidv7(),
      tenant_id uuid not null,
      label text
    );
    create index ${name}_tenant_id_idx on app.${name} (tenant_id);
    alter table app.${name} enable row level security;
    create policy ${name}_tenant_isolation on app.${name} as permissive for all to app_tenant
      using (tenant_id = any ((select app.current_tenant_ids())))
      with check (tenant_id = any ((select app.current_tenant_ids())));
    create policy ${name}_system_access on app.${name} as permissive for all to app_system
      using (true) with check (true);
  `);
}

export async function dropProbe(owner: pg.Client, name: string): Promise<void> {
  await owner.query(`drop table if exists app.${name}`);
}
