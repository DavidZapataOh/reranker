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

// Columns of the generated auth schema that hold no personal data. A column the CLI adds later
// fails the test below until it is classified here or in PERSONAL_DATA.
const NOT_PERSONAL = new Set([
  ...["id", "email_verified", "created_at", "updated_at"].map((c) => `auth.users.${c}`),
  ...["id", "expires_at", "token", "created_at", "updated_at", "user_id"].map(
    (c) => `auth.sessions.${c}`,
  ),
  // Opaque ids of the tenant and team the session points at.
  "auth.sessions.active_organization_id",
  "auth.sessions.active_team_id",
  ...[
    "id",
    "provider_id",
    "user_id",
    "access_token_expires_at",
    "refresh_token_expires_at",
    "scope",
    // Always null: there is no password sign-in.
    "password",
    "created_at",
    "updated_at",
  ].map((c) => `auth.accounts.${c}`),
  ...["id", "expires_at", "created_at", "updated_at"].map((c) => `auth.verifications.${c}`),
  ...["id", "created_at", "kind", "parent_id", "country_code"].map(
    (c) => `auth.organizations.${c}`,
  ),
  // Teams are named by the product ("Principal"), not by people.
  ...["id", "name", "member_count", "organization_id", "created_at", "updated_at"].map(
    (c) => `auth.teams.${c}`,
  ),
  ...["id", "team_id", "user_id", "membership_key", "created_at"].map(
    (c) => `auth.team_members.${c}`,
  ),
  ...["id", "organization_id", "user_id", "role", "created_at", "source"].map(
    (c) => `auth.members.${c}`,
  ),
  ...[
    "id",
    "organization_id",
    "role",
    "team_id",
    "status",
    "expires_at",
    "created_at",
    "inviter_id",
  ].map((c) => `auth.invitations.${c}`),
  ...["id", "count", "last_request"].map((c) => `auth.rate_limits.${c}`),
]);

test("every column of the generated auth schema is classified", () => {
  const inventoried = new Set(
    PERSONAL_DATA.map((entry) => `${entry.schema}.${entry.table}.${entry.column}`),
  );
  const unclassified = [...authColumns].filter(
    (column) => !inventoried.has(column) && !NOT_PERSONAL.has(column),
  );
  expect(unclassified).toEqual([]);
  expect([...NOT_PERSONAL].filter((column) => inventoried.has(column))).toEqual([]);
  expect([...NOT_PERSONAL].filter((column) => !authColumns.has(column))).toEqual([]);
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
    "accounts.account_id": "cascade",
    "users.locale": "cascade",
    "organizations.slug": "cascade",
    "organizations.logo": "cascade",
    "organizations.metadata": "cascade",
    "sessions.ip_address": "job",
    "verifications.value": "job",
    "rate_limits.key": "job",
    "invitations.email": "job",
  });
});
