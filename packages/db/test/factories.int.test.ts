import { eq } from "drizzle-orm";
import { afterAll, expect, test } from "vitest";
import { endPools } from "../src/client";
import { organizations } from "../src/schema";
import { type SystemTx, withSystem } from "../src/tenancy";
import { createTenant } from "./factories";

// Integration files share one database where only one house may exist, so house rows never commit.
class Rollback extends Error {}

async function rolledBack(fn: (tx: SystemTx) => Promise<void>): Promise<void> {
  await expect(
    withSystem("test.setup", async (tx) => {
      await fn(tx);
      throw new Rollback();
    }),
  ).rejects.toBeInstanceOf(Rollback);
}

afterAll(() => endPools());

test("creates a client organization with no members", async () => {
  const id = await withSystem("test.setup", (tx) => createTenant(tx));
  const [row] = await withSystem("test.setup", (tx) =>
    tx.select().from(organizations).where(eq(organizations.id, id)),
  );
  expect(row).toMatchObject({ id, kind: "client", countryCode: "CO", parentId: null });
  expect(row?.slug).toMatch(/^tenant-[0-9a-f]{8}$/);
});

test("creates the house once; a second house violates the partial unique index", async () => {
  await rolledBack(async (tx) => {
    const house = await createTenant(tx, { kind: "house", name: "Casa" });
    const [row] = await tx.select().from(organizations).where(eq(organizations.id, house));
    expect(row).toMatchObject({ kind: "house", name: "Casa" });
    await expect(tx.transaction(() => createTenant(tx, { kind: "house" }))).rejects.toMatchObject({
      cause: { code: "23505" },
    });
  });
});
