import { generateDrizzleJson, generateMigration } from "drizzle-kit/api";
import { expect, expectTypeOf, test } from "vitest";
import config from "../drizzle.config";
import * as schema from "../src/schema";
import * as probe from "./probe/isolation-probe.schema";

const schemaFilter = [config.schemaFilter ?? []].flat();

// The SQL drizzle-kit would emit for the production schema plus the probe tables, from nothing.
async function generatedStatements(): Promise<string[]> {
  const empty = generateDrizzleJson({}, undefined, schemaFilter, "snake_case");
  const current = generateDrizzleJson(
    { ...schema, ...probe },
    empty.id,
    schemaFilter,
    "snake_case",
  );
  return generateMigration(empty, current);
}

const statements = await generatedStatements();
const sql = statements.join("\n");

function statementsFor(table: string): string {
  return statements.filter((statement) => statement.includes(`"${table}"`)).join("\n");
}

test("tenantTable emits RLS, both policies, unique (tenant_id, id), tenant index and cascade FK", () => {
  expect(sql).toContain('ALTER TABLE "app"."isolation_probe" ENABLE ROW LEVEL SECURITY');
  expect(sql).toMatch(
    /CREATE POLICY "isolation_probe_tenant_isolation" ON "app"."isolation_probe" AS PERMISSIVE FOR ALL TO "app_tenant" USING \("app"."isolation_probe"."tenant_id" = any \(\(select app.current_tenant_ids\(\)\)::uuid\[\]\)\) WITH CHECK \("app"."isolation_probe"."tenant_id" = any \(\(select app.current_tenant_ids\(\)\)::uuid\[\]\)\);/,
  );
  expect(sql).toMatch(
    /CREATE POLICY "isolation_probe_system_access" ON "app"."isolation_probe" AS PERMISSIVE FOR ALL TO "app_system" USING \(true\) WITH CHECK \(true\);/,
  );
  expect(sql).toContain('CONSTRAINT "isolation_probe_tenant_id_id_key" UNIQUE("tenant_id","id")');
  expect(sql).toMatch(
    /CREATE INDEX "isolation_probe_tenant_id_idx" ON "app"."isolation_probe" .*\("tenant_id"\)/,
  );
  expect(sql).toMatch(
    /ALTER TABLE "app"."isolation_probe" ADD CONSTRAINT "\w+" FOREIGN KEY \("tenant_id"\) REFERENCES "auth"."organizations"\("id"\) ON DELETE cascade/,
  );
  expect(sql).toContain('"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL');
  expect(sql).toContain('"tenant_id" uuid NOT NULL');
});

test("sameTenant emits a composite FK (tenant_id, probe_id) → (tenant_id, id)", () => {
  expect(sql).toContain(
    'ALTER TABLE "app"."isolation_probe_children" ADD CONSTRAINT "isolation_probe_children_probe_fk" FOREIGN KEY ("tenant_id","probe_id") REFERENCES "app"."isolation_probe"("tenant_id","id")',
  );
});

test("capabilityHash is bytea not null unique; timestamps are timestamptz default now()", () => {
  const children = statementsFor("isolation_probe_children");
  // drizzle-kit quotes custom type names; "bytea" resolves to the built-in type.
  expect(children).toMatch(/"secret_hash" "?bytea"? NOT NULL/);
  expect(children).toContain(
    'CONSTRAINT "isolation_probe_children_secret_hash_unique" UNIQUE("secret_hash")',
  );
  const probeTable = statementsFor("isolation_probe");
  expect(probeTable).toMatch(/"created_at" timestamp with time zone DEFAULT now\(\) NOT NULL/);
  expect(probeTable).toMatch(/"updated_at" timestamp with time zone DEFAULT now\(\) NOT NULL/);
});

test("sharedTable has id and no tenant_id, no policies", () => {
  const shared = statementsFor("shared_probe");
  expect(shared).toContain('CREATE TABLE "public_panel"."shared_probe"');
  expect(shared).toContain('"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL');
  expect(shared).not.toContain("tenant_id");
  expect(shared).not.toContain("POLICY");
  expect(shared).not.toContain("ROW LEVEL SECURITY");
});

test("opsTable adds no column: a composite primaryKey and no id, tenant_id or policy", () => {
  const ops = statementsFor("ops_probe");
  expect(ops).toContain('CREATE TABLE "ops"."ops_probe"');
  expect(ops).toContain('CONSTRAINT "ops_probe_kind_key_pk" PRIMARY KEY("kind","key")');
  expect(ops).not.toMatch(/"id"|tenant_id|POLICY|ROW LEVEL SECURITY/);
});

test("extraction tables: enums in public_panel, natural keys for mentions and places", () => {
  for (const name of [
    "answer_kind",
    "agreement",
    "entity_kind",
    "stance",
    "sentiment",
    "resolution_status",
    "resolution_method",
    "places_outcome",
  ]) {
    expect(sql).toContain(`CREATE TYPE "public_panel"."${name}" AS ENUM(`);
  }
  expect(statementsFor("extractions")).toContain(
    'CONSTRAINT "extractions_capture_id_config_hash_key" UNIQUE("capture_id","config_hash")',
  );
  expect(statementsFor("mentions")).toContain('PRIMARY KEY("extraction_id","start_offset")');
  expect(statementsFor("places")).toContain(
    'PRIMARY KEY("name_hmac","geo_key","category_key","config_hash")',
  );
  expect(sql).toMatch(
    /FOREIGN KEY \("extraction_id"\) REFERENCES "public_panel"\."extractions"\("id"\) ON DELETE cascade/,
  );
  expect(`${statementsFor("mentions")}\n${statementsFor("places")}`).not.toContain('"id" uuid');
});

test('no CREATE ROLE and no CREATE SCHEMA "auth" duplicated in the generated SQL', () => {
  expect(sql).not.toContain("CREATE ROLE");
  expect(sql.match(/CREATE SCHEMA "auth"/g)).toHaveLength(1);
});

// Checked by tsc (the package typecheck covers test/): builders must not widen column types.
test("builders keep full column inference", () => {
  expectTypeOf<typeof probe.isolationProbe.$inferSelect>().toEqualTypeOf<{
    id: string;
    tenantId: string;
    label: string;
    createdAt: Date;
    updatedAt: Date;
  }>();
  expectTypeOf<typeof probe.isolationProbe.$inferInsert>().toEqualTypeOf<{
    id?: string | undefined;
    tenantId: string;
    label: string;
    createdAt?: Date | undefined;
    updatedAt?: Date | undefined;
  }>();
  expectTypeOf<typeof probe.isolationProbeChildren.$inferSelect>().toEqualTypeOf<{
    id: string;
    tenantId: string;
    probeId: string;
    secret: Buffer;
  }>();
  expectTypeOf<typeof probe.sharedProbe.$inferSelect>().toEqualTypeOf<{
    id: string;
    label: string;
  }>();
  expectTypeOf<typeof probe.opsProbe.$inferSelect>().toEqualTypeOf<{ kind: string; key: string }>();
});
