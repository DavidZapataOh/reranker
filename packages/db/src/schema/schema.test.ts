import { getTableConfig, pgTable, text } from "drizzle-orm/pg-core";
import { expect, test } from "vitest";
import {
  appSchema,
  appSystem,
  appTenant,
  authSchema,
  opsSchema,
  publicPanelSchema,
} from "./index.ts";

test("the four product schemas keep their SQL names", () => {
  expect(
    [appSchema, authSchema, publicPanelSchema, opsSchema].map((schema) => schema.schemaName),
  ).toEqual(["app", "auth", "public_panel", "ops"]);
  const table = appSchema.table("probe", { label: text() });
  expect(getTableConfig(table).schema).toBe("app");
  expect(getTableConfig(pgTable("probe", { label: text() })).schema).toBeUndefined();
});

test("the group roles are declared as existing so drizzle-kit never creates or drops them", () => {
  expect([appTenant.name, appSystem.name]).toEqual(["app_tenant", "app_system"]);
  // drizzle-kit skips roles marked existing; the core migration owns them.
  expect(
    [appTenant, appSystem].map((role) => (role as unknown as { _existing?: boolean })._existing),
  ).toEqual([true, true]);
});
