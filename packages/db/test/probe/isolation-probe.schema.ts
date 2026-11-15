import { primaryKey, text, uuid } from "drizzle-orm/pg-core";
import {
  capabilityHash,
  opsTable,
  sameTenant,
  sharedTable,
  tenantTable,
  timestamps,
} from "../../src/schema";

// Test-only tables: they exercise every builder without adding a migration.
export const isolationProbe = tenantTable("isolation_probe", {
  label: text().notNull(),
  ...timestamps(),
});

export const isolationProbeChildren = tenantTable(
  "isolation_probe_children",
  { probeId: uuid().notNull(), secret: capabilityHash("secret_hash") },
  (t) => [
    sameTenant(
      "isolation_probe_children_probe_fk",
      [t.tenantId, t.probeId],
      [isolationProbe.tenantId, isolationProbe.id],
    ),
  ],
);

export const sharedProbe = sharedTable("shared_probe", { label: text().notNull() });

export const opsProbe = opsTable(
  "ops_probe",
  { kind: text().notNull(), key: text().notNull() },
  (t) => [primaryKey({ columns: [t.kind, t.key] })],
);
