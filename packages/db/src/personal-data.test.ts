import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import { expect, test } from "vitest";
import { PERSONAL_DATA } from "./personal-data";
import * as authTables from "./schema/auth";

const authColumns = new Set(
  Object.values(authTables)
    .filter((entry) => is(entry, PgTable))
    .flatMap((table) => {
      const { name, columns } = getTableConfig(table);
      return columns.map((column) => `auth.${name}.${column.name}`);
    }),
);

test("every auth entry names a column of the generated auth schema", () => {
  const auth = PERSONAL_DATA.filter((entry) => entry.schema === "auth");
  expect(auth.length).toBeGreaterThan(0);
  for (const entry of auth) {
    expect(authColumns).toContain(`auth.${entry.table}.${entry.column}`);
  }
});

test("each column is inventoried once, with a purpose and a retention", () => {
  const keys = PERSONAL_DATA.map((entry) => `${entry.schema}.${entry.table}.${entry.column}`);
  expect(new Set(keys).size).toBe(keys.length);
  for (const entry of PERSONAL_DATA) {
    expect(entry.purpose.trim()).not.toBe("");
    expect(entry.retention.trim()).not.toBe("");
  }
});

test("the sign-in records that expire are purged by a job, the account data by cascade", () => {
  const erasure = Object.fromEntries(
    PERSONAL_DATA.map((entry) => [`${entry.table}.${entry.column}`, entry.erasure]),
  );
  expect(erasure).toMatchObject({
    "users.email": "cascade",
    "users.data_policy_accepted_at": "cascade",
    "accounts.refresh_token": "cascade",
    "sessions.ip_address": "job",
    "verifications.value": "job",
    "rate_limits.key": "job",
    "invitations.email": "job",
  });
});
