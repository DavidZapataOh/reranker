import { is } from "drizzle-orm";
import { PgSchema } from "drizzle-orm/pg-core";
import { expect, test } from "vitest";
import config from "../../drizzle.config";
import * as schema from "./index";

// drizzle-kit silently skips tables in a schema missing from schemaFilter.
test("every declared pgSchema is in the drizzle-kit schemaFilter", () => {
  const declared = Object.values(schema)
    .filter((entry) => is(entry, PgSchema))
    .map((entry) => entry.schemaName);
  expect(declared.sort()).toEqual([...(config.schemaFilter ?? [])].sort());
});
