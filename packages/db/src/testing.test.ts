import { text, uuid } from "drizzle-orm/pg-core";
import { expect, test } from "vitest";
import { isolationProbe, sharedProbe } from "../test/probe/isolation-probe.schema";
import { appSchema } from "./schema";
import type { SystemTx } from "./tenancy";
import { asTenantId } from "./tenancy";
import { defineTenantFixture } from "./testing";

const tenant = asTenantId("0190a6f0-0000-7000-8000-000000000001");

test("names the table and finds its id and tenant_id columns", async () => {
  const fixture = defineTenantFixture(isolationProbe, (tenantId) => ({ tenantId, label: "x" }));
  expect(fixture.name).toBe("isolation_probe");
  expect(fixture.table).toBe(isolationProbe);
  expect(fixture.id).toBe(isolationProbe.id);
  expect(fixture.tenantId).toBe(isolationProbe.tenantId);
  expect(await fixture.build(tenant, {} as SystemTx)).toEqual({ tenantId: tenant, label: "x" });
});

test("rejects tables outside app and app tables without tenant_id", () => {
  expect(() => defineTenantFixture(sharedProbe, () => ({ label: "x" }))).toThrow(
    "shared_probe: tenant fixtures are only for tables in the app schema",
  );
  const noTenant = appSchema.table("no_tenant", { id: uuid().primaryKey(), label: text() });
  expect(() => defineTenantFixture(noTenant, () => ({ id: "x" }))).toThrow(
    "no_tenant: a tenant table needs id and tenant_id columns",
  );
});
