import { text, uuid } from "drizzle-orm/pg-core";
import { appSchema } from "../src/schema/index.ts";
import { uniqueSuffix, withClient } from "./support.ts";

// A tenant table with the production policy shape and no foreign key, created only on the CI branch.
export function defineProbe(prefix: string) {
  const name = `${prefix}_${uniqueSuffix()}`;
  const table = appSchema.table(name, {
    id: uuid().primaryKey(),
    tenantId: uuid().notNull(),
    label: text(),
  });

  const create = () =>
    withClient("migrations", async (owner) => {
      const t = `app.${owner.escapeIdentifier(name)}`;
      // Without the cast Postgres reads ANY ((select …)) as a subquery and compares uuid to uuid[];
      // the scalar subquery still runs once per statement as an InitPlan.
      const predicate = "tenant_id = any ((select app.current_tenant_ids())::uuid[])";
      await owner.query(`
        create table ${t} (id uuid primary key default uuidv7(), tenant_id uuid not null, label text);
        create index on ${t} (tenant_id);
        alter table ${t} enable row level security;
        create policy tenant_isolation on ${t} as permissive for all to app_tenant
          using (${predicate}) with check (${predicate});
        create policy system_access on ${t} as permissive for all to app_system
          using (true) with check (true);
      `);
    });

  const drop = () =>
    withClient("migrations", (owner) =>
      owner.query(`drop table if exists app.${owner.escapeIdentifier(name)}`),
    );

  return { name, table, create, drop };
}
