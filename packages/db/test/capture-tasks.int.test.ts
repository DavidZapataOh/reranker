import { randomUUID } from "node:crypto";
import { getTestDatabaseUrl } from "@reranker/testing/neon";
import pg from "pg";
import { expect, test } from "vitest";

async function withClient<T>(role: "app" | "system", fn: (c: pg.Client) => Promise<T>) {
  const client = new pg.Client({ connectionString: getTestDatabaseUrl(role) });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

test("the tenant runtime role cannot reach ops.capture_tasks", async () => {
  await withClient("app", (c) =>
    expect(c.query("select * from ops.capture_tasks")).rejects.toMatchObject({
      message: expect.stringContaining("permission denied for schema ops"),
    }),
  );
});

test("a slot can be claimed once", async () => {
  const slotId = `${randomUUID()}:0`;
  const claim = (c: pg.Client) =>
    c.query(
      `insert into ops.capture_tasks (slot_id, measurement_id, provider, engine, claim_token)
       values ($1, $2, 'dataforseo', 'gemini', $3) on conflict do nothing returning slot_id`,
      [slotId, slotId.split(":")[0], randomUUID()],
    );
  await withClient("system", async (c) => {
    expect((await claim(c)).rowCount).toBe(1);
    expect((await claim(c)).rowCount).toBe(0);
    await c.query("delete from ops.capture_tasks where slot_id = $1", [slotId]);
  });
});
