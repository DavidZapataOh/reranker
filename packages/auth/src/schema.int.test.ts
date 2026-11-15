import { endPools, type SystemTx, withSystem } from "@reranker/db";
import { organizations } from "@reranker/db/schema";
import { getTestDatabaseUrl } from "@reranker/testing/neon";
import { sql } from "drizzle-orm";
import pg from "pg";
import { afterAll, expect, test } from "vitest";

afterAll(() => endPools());

type Column = {
  column_name: string;
  data_type: string;
  is_nullable: string;
  column_default: string | null;
};

async function columns(table: string): Promise<Record<string, Column>> {
  const { rows } = await withSystem("test.schema", (tx) =>
    tx.execute<Column>(sql`
      select column_name, data_type, is_nullable, column_default
      from information_schema.columns
      where table_schema = 'auth' and table_name = ${table}`),
  );
  return Object.fromEntries(rows.map((row) => [row.column_name, row]));
}

function organization(kind: string) {
  const id = crypto.randomUUID();
  return { id, name: kind, slug: `schema-${id}`, kind, countryCode: "CO", createdAt: new Date() };
}

test("organizations carry kind, parent and country", async () => {
  expect(await columns("organizations")).toMatchObject({
    kind: { data_type: "text", is_nullable: "NO" },
    parent_id: { data_type: "uuid", is_nullable: "YES" },
    country_code: { data_type: "text", is_nullable: "NO" },
  });
});

test("members default to a direct membership", async () => {
  expect((await columns("members")).source).toMatchObject({
    data_type: "text",
    is_nullable: "NO",
    column_default: "'direct'::text",
  });
});

test("users keep their locale and the data authorization they accepted", async () => {
  expect(await columns("users")).toMatchObject({
    locale: { data_type: "text" },
    data_policy_version: { data_type: "text" },
    data_policy_accepted_at: { data_type: "timestamp without time zone" },
  });
});

test("teams, team members and rate limits exist", async () => {
  for (const table of ["teams", "team_members", "rate_limits"]) {
    expect(Object.keys(await columns(table)), table).not.toHaveLength(0);
  }
});

test("only one house can exist", async () => {
  // Rolled back: integration files share the database and a committed house would block the rest.
  class Rollback extends Error {}
  await expect(
    withSystem("test.schema", async (tx: SystemTx) => {
      await tx.insert(organizations).values(organization("house"));
      await expect(
        tx.transaction((inner) => inner.insert(organizations).values(organization("house"))),
      ).rejects.toMatchObject({ cause: { code: "23505" } });
      throw new Rollback();
    }),
  ).rejects.toBeInstanceOf(Rollback);
});

test("membership lookups and organization children are indexed", async () => {
  const { rows } = await withSystem("test.schema", (tx) =>
    tx.execute<{ indexname: string }>(
      sql`select indexname from pg_indexes where schemaname = 'auth'`,
    ),
  );
  expect(rows.map((row) => row.indexname)).toEqual(
    expect.arrayContaining([
      "members_user_id_organization_id_idx",
      "organizations_parentId_idx",
      "organizations_single_house_idx",
    ]),
  );
});

test("the tenant role cannot read the auth schema", async () => {
  const client = new pg.Client({ connectionString: getTestDatabaseUrl("app") });
  await client.connect();
  try {
    await expect(client.query("select 1 from auth.users")).rejects.toMatchObject({
      code: "42501",
    });
  } finally {
    await client.end();
  }
});
