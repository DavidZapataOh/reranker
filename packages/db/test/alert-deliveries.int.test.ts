import { getTestDatabaseUrl } from "@reranker/testing/neon";
import pg from "pg";
import { expect, test } from "vitest";

test("the tenant runtime role cannot reach ops.alert_deliveries", async () => {
  const client = new pg.Client({ connectionString: getTestDatabaseUrl("app") });
  await client.connect();
  try {
    await expect(client.query("select * from ops.alert_deliveries")).rejects.toMatchObject({
      message: expect.stringContaining("permission denied for schema ops"),
    });
  } finally {
    await client.end();
  }
});
