import { randomBytes } from "node:crypto";
import { getTestDatabaseUrl } from "@reranker/testing/neon";
import { sql } from "drizzle-orm";
import { text, uuid } from "drizzle-orm/pg-core";
import pg from "pg";
import { appSchema } from "../src/schema";

// A throwaway tenant table with the production policies, created by the owner so the default
// privileges grant it to app_tenant and app_system exactly as a migrated table.
export async function createProbeTable() {
  const name = `tenancy_probe_${randomBytes(5).toString("hex")}`;
  const owner = new pg.Client({ connectionString: getTestDatabaseUrl("migrations") });
  await owner.connect();
  await owner
    .query(`
    create table app.${name} (id uuid default uuidv7() primary key, tenant_id uuid not null, label text);
    alter table app.${name} enable row level security;
    create policy tenant_rows on app.${name} as permissive for all to app_tenant
      using (tenant_id = any ((select app.current_tenant_ids())::uuid[]))
      with check (tenant_id = any ((select app.current_tenant_ids())::uuid[]));
    create policy system_rows on app.${name} as permissive for all to app_system
      using (true) with check (true);
  `)
    .catch(async (error: unknown) => {
      await owner.end();
      throw error;
    });
  const table = appSchema.table(name, {
    id: uuid().primaryKey().default(sql`uuidv7()`),
    tenantId: uuid().notNull(),
    label: text(),
  });
  return {
    name,
    table,
    owner,
    drop: async () => {
      try {
        // Bounded so a transaction left open by a failed test cannot keep the table forever.
        await owner.query("set lock_timeout = '5s'");
        await owner.query(`drop table if exists app.${name}`);
      } finally {
        await owner.end();
      }
    },
  };
}
