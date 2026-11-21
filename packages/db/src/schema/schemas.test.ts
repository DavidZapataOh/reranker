import { MeasurementLanguage } from "@reranker/schema/measurement";
import { is, sql } from "drizzle-orm";
import { getTableConfig, PgDialect, PgSchema } from "drizzle-orm/pg-core";
import { expect, test } from "vitest";
import config from "../../drizzle.config";
import { intentSets, intents, personas } from "./catalog";
import * as schema from "./index";

// drizzle-kit silently skips tables in a schema missing from schemaFilter.
test("every declared pgSchema is in the drizzle-kit schemaFilter", () => {
  const declared = Object.values(schema)
    .filter((entry) => is(entry, PgSchema))
    .map((entry) => entry.schemaName);
  expect(declared.sort()).toEqual([...(config.schemaFilter ?? [])].sort());
});

test.each([
  ["intent_sets", intentSets],
  ["intents", intents],
  ["personas", personas],
] as const)("%s accepts exactly the measurement languages", (name, table) => {
  const check = getTableConfig(table).checks.find((c) => c.name === `${name}_language_check`);
  const listed = new PgDialect()
    .sqlToQuery(check?.value ?? sql``)
    .sql.match(/'([a-z]+)'/g)
    ?.map((quoted) => quoted.slice(1, -1));
  expect(listed).toEqual(MeasurementLanguage.options);
});
